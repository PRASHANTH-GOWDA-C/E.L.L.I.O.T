import express from 'express';
import config from '../config.js';

const NAME = 'Elliot';
const VERSION = '0.1.0';

const app = express();

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: NAME, version: VERSION });
});

app.use(express.static(config.paths.web));

const server = app.listen(config.port, () => {
  console.log(`${NAME} v${VERSION} listening on http://localhost:${config.port} (AI mode: ${config.aiMode})`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
