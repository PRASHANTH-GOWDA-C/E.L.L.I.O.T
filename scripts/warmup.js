// Loads the coder model into memory so the first real reply is fast.
// Started in the background by start-elliot.bat / start-elliot.sh.
// Uses Ollama's native API: a /api/generate request without a prompt only loads the model.
import config from '../app/core/config.js';

const model = config.models.coder.name;
try {
  const res = await fetch(`${config.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: -1 }),
    signal: AbortSignal.timeout(10 * 60_000), // loading from a slow USB drive can take minutes
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(`warm-up: ${model}: ${body.error ?? `HTTP ${res.status}`}`);
    process.exitCode = 1;
  } else {
    console.log(`warm-up: ${model} is loaded`);
  }
} catch (err) {
  console.error(`warm-up: could not load ${model}: ${err.message}`);
  process.exitCode = 1;
}
