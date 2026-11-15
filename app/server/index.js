import express from 'express';
import config from '../config.js';
import { chat, listModels, isModelInstalled, LlmError } from './llm.js';

const NAME = 'Elliot';
const VERSION = '0.1.0';
const MAX_TEST_MESSAGE_LENGTH = 4_000;

const app = express();

app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: NAME, version: VERSION });
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
  if (typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'Body must be JSON: { "message": "<non-empty string>" }' });
  }
  if (message.length > MAX_TEST_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `message must be at most ${MAX_TEST_MESSAGE_LENGTH} characters` });
  }

  const model = config.models.coder.name;
  const started = performance.now();
  try {
    const reply = await chat({ model, messages: [{ role: 'user', content: message }] });
    res.json({ reply, model, ms: Math.round(performance.now() - started) });
  } catch (err) {
    next(err);
  }
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
  console.log(`${NAME} v${VERSION} listening on http://localhost:${config.port} (AI mode: ${config.aiMode})`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
