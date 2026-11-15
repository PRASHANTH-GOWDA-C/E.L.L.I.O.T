// Minimal LLM client. Chat goes through the OpenAI-compatible endpoint so the
// base URL can later point at an online gateway; Ollama's native API is used
// only to list installed models.
import config from '../config.js';

const LIST_TIMEOUT_MS = 3_000;
const CHAT_TIMEOUT_MS = 180_000; // CPU-only cold load of a 7B model can take a while

export class LlmError extends Error {
  /**
   * @param {'OLLAMA_OFFLINE'|'MODEL_MISSING'|'TIMEOUT'|'BAD_RESPONSE'} code
   */
  constructor(code, message, { model, cause } = {}) {
    super(message, { cause });
    this.name = 'LlmError';
    this.code = code;
    this.model = model;
  }
}

const offlineError = (cause) =>
  new LlmError('OLLAMA_OFFLINE', 'Ollama is not running — start it with `ollama serve`', { cause });

const missingModelError = (model) =>
  new LlmError('MODEL_MISSING', `Model ${model} is not installed — run \`ollama pull ${model}\``, { model });

async function request(path, { timeoutMs, ...init }) {
  try {
    return await fetch(`${config.ollamaUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new LlmError('TIMEOUT', `No response from ${config.ollamaUrl}${path} within ${timeoutMs / 1000}s`, { cause: err });
    }
    // fetch throws TypeError for connection refused / DNS / network failures.
    throw offlineError(err);
  }
}

/** Ollama treats "name" and "name:latest" as the same model. */
export function normalizeModelName(name) {
  return name.includes(':') ? name : `${name}:latest`;
}

export function isModelInstalled(installed, name) {
  const target = normalizeModelName(name);
  return installed.some((m) => normalizeModelName(m) === target);
}

/** @returns {Promise<string[]>} installed model names */
export async function listModels() {
  let res;
  try {
    res = await request('/api/tags', { method: 'GET', timeoutMs: LIST_TIMEOUT_MS });
  } catch (err) {
    // A server that can't answer a tiny listing call in time is effectively offline.
    if (err instanceof LlmError && err.code === 'TIMEOUT') throw offlineError(err);
    throw err;
  }
  if (!res.ok) throw new LlmError('BAD_RESPONSE', `Ollama /api/tags returned HTTP ${res.status}`);
  const data = await res.json();
  return (data.models ?? []).map((m) => m.name);
}

/** @returns {Promise<boolean>} */
export async function isOnline() {
  try {
    await listModels();
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-streaming chat completion.
 * @param {{ model: string, messages: {role: string, content: string}[], timeoutMs?: number }} opts
 * @returns {Promise<string>} the assistant's reply text
 */
export async function chat({ model, messages, timeoutMs = CHAT_TIMEOUT_MS }) {
  if (!model) throw new TypeError('chat(): model is required');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('chat(): messages must be a non-empty array');
  }

  const res = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
    timeoutMs,
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = body?.error?.message ?? body?.error ?? '';
    if (res.status === 404 || /not found|try pulling/i.test(String(detail))) {
      throw missingModelError(model);
    }
    throw new LlmError('BAD_RESPONSE', `Chat request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, { model });
  }

  const reply = body?.choices?.[0]?.message?.content;
  if (typeof reply !== 'string') {
    throw new LlmError('BAD_RESPONSE', 'Chat response did not contain a message', { model });
  }
  return reply;
}
