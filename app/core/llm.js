// Minimal LLM client. Chat goes through the OpenAI-compatible endpoint so the
// base URL can later point at an online gateway; Ollama's native API is used
// only to list installed models.
import config from './config.js';

const LIST_TIMEOUT_MS = 3_000;
const CHAT_TIMEOUT_MS = 180_000; // CPU-only cold load of a 7B model can take a while
const STREAM_IDLE_TIMEOUT_MS = 60_000; // max silence between streamed chunks

export class LlmError extends Error {
  /**
   * @param {'OLLAMA_OFFLINE'|'MODEL_MISSING'|'TIMEOUT'|'ABORTED'|'BAD_RESPONSE'|'TOOLS_UNSUPPORTED'} code
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

export const missingModelError = (model) =>
  new LlmError('MODEL_MISSING', `Model ${model} is not installed — run \`ollama pull ${model}\``, { model });

const isAbortLike = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';

async function request(path, { timeoutMs, ...init }) {
  try {
    return await fetch(`${config.ollamaUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isAbortLike(err)) {
      throw new LlmError('TIMEOUT', `No response from ${config.ollamaUrl}${path} within ${timeoutMs / 1000}s`, { cause: err });
    }
    // fetch throws TypeError for connection refused / DNS / network failures.
    throw offlineError(err);
  }
}

/** Turns a non-2xx chat response into an LlmError. */
async function responseError(res, model) {
  const body = await res.json().catch(() => null);
  const detail = body?.error?.message ?? body?.error ?? '';
  if (res.status === 404 || /not found|try pulling/i.test(String(detail))) {
    return missingModelError(model);
  }
  return new LlmError('BAD_RESPONSE', `Chat request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, { model });
}

function validateChatArgs(model, messages) {
  if (!model) throw new TypeError('model is required');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('messages must be a non-empty array');
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
  validateChatArgs(model, messages);

  const res = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
    timeoutMs,
  });

  if (!res.ok) throw await responseError(res, model);

  const body = await res.json().catch(() => null);
  const reply = body?.choices?.[0]?.message?.content;
  if (typeof reply !== 'string') {
    throw new LlmError('BAD_RESPONSE', 'Chat response did not contain a message', { model });
  }
  return reply;
}

/**
 * One non-streaming chat turn with OpenAI-style tools.
 * @param {{ model: string, messages: object[], tools: object[], signal?: AbortSignal, timeoutMs?: number }} opts
 * @returns {Promise<{ content: string|null, tool_calls?: object[] }>} the assistant message
 * @throws {LlmError} codes as chat(), plus 'TOOLS_UNSUPPORTED' and 'ABORTED'
 */
export async function chatWithTools({ model, messages, tools, signal, timeoutMs = CHAT_TIMEOUT_MS }) {
  validateChatArgs(model, messages);
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${config.ollamaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: false }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new LlmError('ABORTED', 'Stopped', { model, cause: err });
    if (timeout.aborted) throw new LlmError('TIMEOUT', `No reply from ${model} within ${timeoutMs / 1000}s`, { model, cause: err });
    throw offlineError(err);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = String(body?.error?.message ?? body?.error ?? '');
    if (/does not support tools/i.test(detail)) {
      throw new LlmError('TOOLS_UNSUPPORTED', `${model} does not support tool calls`, { model });
    }
    if (res.status === 404 || /not found|try pulling/i.test(detail)) throw missingModelError(model);
    throw new LlmError('BAD_RESPONSE', `Chat request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, { model });
  }
  const message = body?.choices?.[0]?.message;
  if (!message) throw new LlmError('BAD_RESPONSE', 'Chat response did not contain a message', { model });
  return message;
}

/**
 * @typedef {{ model: string, ms: number, chars: number, tokens: number|null, tokensPerSec: number|null }} StreamStats
 */

/**
 * Streaming chat completion. Yields text chunks as they arrive and returns
 * StreamStats when the stream ends. Pass an AbortSignal to cancel; a
 * cancelled stream throws LlmError with code 'ABORTED'.
 *
 * Timeouts: CHAT_TIMEOUT_MS until the first chunk (covers model loading),
 * then STREAM_IDLE_TIMEOUT_MS of silence between chunks.
 *
 * @param {{ model: string, messages: {role: string, content: string}[], signal?: AbortSignal, json?: boolean }} opts
 *   json: ask for a JSON object reply (OpenAI response_format; Ollama enforces valid JSON)
 * @returns {AsyncGenerator<string, StreamStats, void>}
 */
export async function* chatStream({ model, messages, signal, json = false }) {
  validateChatArgs(model, messages);
  if (signal?.aborted) throw new LlmError('ABORTED', 'Stopped', { model });

  const timeout = new AbortController();
  let timeoutMs = CHAT_TIMEOUT_MS;
  let timer = setTimeout(() => timeout.abort(), timeoutMs);
  const resetTimer = (ms) => {
    clearTimeout(timer);
    timeoutMs = ms;
    timer = setTimeout(() => timeout.abort(), ms);
  };
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

  // Map low-level failures to a clear LlmError.
  const toLlmError = (err) => {
    if (err instanceof LlmError) return err;
    if (signal?.aborted) return new LlmError('ABORTED', 'Stopped', { model, cause: err });
    if (timeout.signal.aborted) {
      return new LlmError('TIMEOUT', `No reply from ${model} within ${timeoutMs / 1000}s`, { model, cause: err });
    }
    if (err instanceof SyntaxError) {
      return new LlmError('BAD_RESPONSE', 'Received malformed data from the model stream', { model, cause: err });
    }
    return offlineError(err);
  };

  const started = performance.now();
  let firstChunkAt = null;
  let chars = 0;
  let usage = null;
  let reader;

  try {
    let res;
    try {
      res = await fetch(`${config.ollamaUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(json && { response_format: { type: 'json_object' } }),
        }),
        signal: combined,
      });
    } catch (err) {
      throw toLlmError(err);
    }
    if (!res.ok) throw await responseError(res, model);

    reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let finished = false;

    while (!finished) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw toLlmError(err);
      }
      if (chunk.done) break;
      buffer += chunk.value;

      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          finished = true;
          break;
        }

        let event;
        try {
          event = JSON.parse(data);
        } catch (err) {
          throw toLlmError(err);
        }
        if (event.error) {
          throw new LlmError('BAD_RESPONSE', `Model error: ${event.error.message ?? event.error}`, { model });
        }
        if (event.usage) usage = event.usage;

        const delta = event.choices?.[0]?.delta;
        // Thinking models (qwen3, deepseek-r1) stream their reasoning separately.
        // It isn't shown, but it proves the model is alive, so it resets the timeout.
        if (delta?.reasoning || delta?.reasoning_content) resetTimer(STREAM_IDLE_TIMEOUT_MS);

        const text = delta?.content;
        if (text) {
          firstChunkAt ??= performance.now();
          chars += text.length;
          resetTimer(STREAM_IDLE_TIMEOUT_MS);
          yield text;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    // Releases the connection if the consumer stopped early or an error occurred.
    reader?.cancel().catch(() => {});
  }

  const ended = performance.now();
  const tokens = Number.isInteger(usage?.completion_tokens) ? usage.completion_tokens : null;
  // Generation speed is measured from the first chunk, so model load time doesn't skew it.
  const genSeconds = firstChunkAt ? (ended - firstChunkAt) / 1000 : 0;
  const tokensPerSec = tokens && genSeconds > 0 ? Math.round((tokens / genSeconds) * 10) / 10 : null;

  return { model, ms: Math.round(ended - started), chars, tokens, tokensPerSec };
}
