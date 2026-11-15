// Local HTTP API (for Edward and the phone). The CLI is Elliot's main interface.
import express from 'express';
import config from '../core/config.js';
import { chat, listModels, isModelInstalled, LlmError } from '../core/llm.js';
import { Session } from '../core/session.js';

const MAX_MESSAGE_LENGTH = 4_000;

const app = express();

app.use(express.json({ limit: '100kb' }));

/** Returns an error string, or null if the message is valid. */
function validateMessage(message) {
  if (typeof message !== 'string' || message.trim() === '') {
    return 'Body must be JSON: { "message": "<non-empty string>" }';
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return `message must be at most ${MAX_MESSAGE_LENGTH} characters`;
  }
  return null;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: config.name, version: config.version });
});

app.get('/api/models', async (req, res, next) => {
  try {
    let installed = [];
    let ollama = 'online';
    try {
      installed = await listModels();
    } catch (err) {
      if (!(err instanceof LlmError) || err.code !== 'OLLAMA_OFFLINE') throw err;
      ollama = 'offline';
    }
    const required = Object.entries(config.models).map(([role, { name }]) => ({
      name,
      role,
      installed: isModelInstalled(installed, name),
    }));
    res.json({ ollama, installed, required });
  } catch (err) {
    next(err);
  }
});

app.post('/api/chat/test', async (req, res, next) => {
  const message = req.body?.message;
  const invalid = validateMessage(message);
  if (invalid) return res.status(400).json({ error: invalid });

  const model = config.models.coder.name;
  const started = performance.now();
  try {
    const reply = await chat({ model, messages: [{ role: 'user', content: message }] });
    res.json({ reply, model, ms: Math.round(performance.now() - started) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/chat { message } → Server-Sent Events:
 *   event: chunk  data: { "text": "..." }
 *   event: done   data: { model, ms, chars, tokens, tokensPerSec }
 *   event: error  data: { error, code }   (only for failures after streaming started)
 * Failures before the first chunk (Ollama offline, model missing) return a
 * normal JSON error with a 4xx/5xx status instead.
 * Each request is a fresh Session; conversation memory comes in a later step.
 */
app.post('/api/chat', async (req, res, next) => {
  const message = req.body?.message;
  const invalid = validateMessage(message);
  if (invalid) return res.status(400).json({ error: invalid });

  const controller = new AbortController();
  // Client disconnected before we finished → stop generating.
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  const stream = new Session().send(message, { signal: controller.signal });
  const sendEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let result;
  try {
    // Wait for the first chunk so setup errors can still use a proper status code.
    result = await stream.next();
  } catch (err) {
    if (err instanceof LlmError && err.code === 'ABORTED') return;
    return next(err);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    while (!result.done) {
      sendEvent('chunk', { text: result.value });
      result = await stream.next();
    }
    sendEvent('done', result.value);
  } catch (err) {
    if (err instanceof LlmError && err.code === 'ABORTED') return;
    sendEvent('error', {
      error: err instanceof LlmError ? err.message : 'Internal server error',
      code: err instanceof LlmError ? err.code : 'INTERNAL',
    });
    if (!(err instanceof LlmError)) console.error(err);
  }
  res.end();
});

app.use(express.static(config.paths.web));

// Errors: always JSON, with a status that matches the cause.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof LlmError) {
    const status = { OLLAMA_OFFLINE: 503, MODEL_MISSING: 503, TIMEOUT: 504 }[err.code] ?? 502;
    return res.status(status).json({ error: err.message, code: err.code, ...(err.model && { model: err.model }) });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, () => {
  console.log(`${config.name} API v${config.version} listening on http://localhost:${config.port} (AI mode: ${config.aiMode})`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
