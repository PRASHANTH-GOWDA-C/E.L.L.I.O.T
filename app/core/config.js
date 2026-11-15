import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { resolvePaths } from './paths.js';

// Elliot's own folders come from where the code lives (see paths.js), so .env
// and memory/elliot.db are found no matter which folder `elliot` runs in.
const PATHS = Object.freeze(resolvePaths());
export const ROOT_DIR = PATHS.root;
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

const toBool = (value) => ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());

const config = Object.freeze({
  name: 'Elliot',
  version: pkg.version,
  port: toPort(process.env.PORT, 3000),
  ollamaUrl: env('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  aiMode: env('AI_MODE', 'offline'),
  models: MODELS,
  // Let the router pick the (slow, thinking) reason model automatically.
  // Off by default: on a CPU-only laptop it can think silently for minutes.
  autoReason: toBool(env('AUTO_REASON', 'false')),
  // An unknown ELLIOT_VOICE falls back to plain rather than breaking startup.
  voice: VOICES.includes(voice) ? voice : 'plain',
  paths: PATHS,
});

export default config;
