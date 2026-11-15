import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project root is two levels above app/core/. Load .env from there so Elliot
// works no matter which directory it is launched from (e.g. a USB drive).
export const ROOT_DIR = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

function toPort(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

function env(name, fallback) {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

// Model roles. "always" models stay loaded; "on-demand" ones load when needed.
const MODELS = Object.freeze({
  coder: Object.freeze({ name: env('CODER_MODEL', 'qwen2.5-coder:7b'), load: 'always' }),
  tools: Object.freeze({ name: env('TOOLS_MODEL', 'qwen3:4b'), load: 'always' }),
  embed: Object.freeze({ name: env('EMBED_MODEL', 'nomic-embed-text'), load: 'always' }),
  reason: Object.freeze({ name: env('REASON_MODEL', 'deepseek-r1:8b'), load: 'on-demand' }),
  vision: Object.freeze({ name: env('VISION_MODEL', 'qwen3.5:9b'), load: 'on-demand' }),
  fast: Object.freeze({ name: env('FAST_MODEL', 'qwen2.5-coder:1.5b'), load: 'on-demand' }),
});

// Speaking styles for Elliot's persona (see persona.js).
export const VOICES = Object.freeze(['plain', 'alderson']);
const voice = env('ELLIOT_VOICE', 'plain').toLowerCase();

const config = Object.freeze({
  name: 'Elliot',
  version: pkg.version,
  port: toPort(process.env.PORT, 3000),
  ollamaUrl: env('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  aiMode: env('AI_MODE', 'offline'),
  models: MODELS,
  // An unknown ELLIOT_VOICE falls back to plain rather than breaking startup.
  voice: VOICES.includes(voice) ? voice : 'plain',
  paths: Object.freeze({
    root: ROOT_DIR,
    web: path.join(ROOT_DIR, 'app', 'web'),
    memory: path.join(ROOT_DIR, 'memory'),
    models: path.join(ROOT_DIR, 'models'),
  }),
});

export default config;
