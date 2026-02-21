const express = require('express');
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// In-memory job store (fine for Railway — use Redis/Postgres for production)
const jobs = {};

// ─── POST /api/generate/video ───
app.post('/api/generate/video', async (req, res) => {
  const { prompt, duration, scene_index, scene_name, camera_motion, style } = req.body;

  if (!prompt) return res.status(400).json({ message: 'prompt is required' });
  if (!process.env.RUNWAY_API_KEY) return res.status(500).json({ message: 'RUNWAY_API_KEY not set on server' });

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  jobs[jobId] = { id: jobId, status: 'pending', progress: 0, output_url: null, error: null };

  // Fire and forget
  runGeneration(jobId, { prompt, duration: duration || 5, camera_motion, style, scene_name });

  res.json({ job_id: jobId });
});

// ─── GET /api/jobs/:id ───
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ message: 'Job not found' });
  res.json(job);
});

// ─── Health check ───
app.get('/', (req, res) => res.json({ status: 'FRAMEFORGE backend running ✓' }));

// ─── Runway generation ───
async function runGeneration(jobId, payload) {
  try {
    // Step 1: Create Runway task
    const createRes = await fetch('https://api.dev.runwayml.com/v1/text_to_video', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RUNWAY_API_KEY}`,
        'X-Runway-Version': '2024-11-06'
      },
      body: JSON.stringify({
        model: 'gen3a_turbo',
        promptText: payload.prompt,
        duration: Math.min(payload.duration || 5, 10), // Runway max is 10s
        ratio: '1280:720'
      })
    });

    if (!createRes.ok) {
      const errBody = await createRes.text();
      throw new Error(`Runway rejected request: ${createRes.status} — ${errBody}`);
    }

    const task = await createRes.json();
    console.log(`[${jobId}] Runway task created: ${task.id}`);
    jobs[jobId].status = 'processing';
    jobs[jobId].progress = 5;

    // Step 2: Poll Runway until done
    let attempts = 0;
    const maxAttempts = 80; // ~4 minutes

    while (attempts < maxAttempts) {
      await sleep(3000);
      attempts++;

      const pollRes = await fetch(`https://api.dev.runwayml.com/v1/tasks/${task.id}`, {
        headers: {
          'Authorization': `Bearer ${process.env.RUNWAY_API_KEY}`,
          'X-Runway-Version': '2024-11-06'
        }
      });

      if (!pollRes.ok) {
        console.warn(`[${jobId}] Poll failed (attempt ${attempts}): ${pollRes.status}`);
        continue;
      }

      const t = await pollRes.json();
      const progress = Math.round((t.progress || 0) * 90 + 5);
      jobs[jobId].progress = progress;
      console.log(`[${jobId}] status=${t.status} progress=${progress}%`);

      if (t.status === 'SUCCEEDED') {
        jobs[jobId].status = 'done';
        jobs[jobId].progress = 100;
        jobs[jobId].output_url = t.output[0];
        console.log(`[${jobId}] Done! URL: ${t.output[0]}`);
        return;
      }

      if (t.status === 'FAILED') {
        throw new Error(t.failure || t.failureCode || 'Runway task failed');
      }
    }

    throw new Error('Generation timed out after 4 minutes');

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = err.message;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FRAMEFORGE backend listening on port ${PORT}`));
