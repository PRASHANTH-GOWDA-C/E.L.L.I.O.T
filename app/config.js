import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project root is one level above app/. Load .env from there so the app
// works no matter which directory it is launched from (e.g. a USB drive).
export const ROOT_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

function toPort(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

const config = Object.freeze({
  port: toPort(process.env.PORT, 3000),
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  aiMode: process.env.AI_MODE || 'offline',
  paths: Object.freeze({
    root: ROOT_DIR,
    web: path.join(ROOT_DIR, 'app', 'web'),
    memory: path.join(ROOT_DIR, 'memory'),
    models: path.join(ROOT_DIR, 'models'),
  }),
});

export default config;
