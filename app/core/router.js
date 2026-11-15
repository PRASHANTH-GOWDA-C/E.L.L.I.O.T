// Picks a model role for a message. Pure: no network, no state.
import config from './config.js';
import { isModelInstalled } from './llm.js';

const MAX_FAST_WORDS = 8;
const LONG_ERROR_CHARS = 1_500;

// Words and phrases that signal hard reasoning or debugging.
const REASON_WORDS =
  /\b(why|debug(?:ging)?|race conditions?|deadlocks?|complexity|prove|proof|big[- ]?o|optimi[sz]e|memory leaks?)\b|\bO\([^)]*\)/i;

// Stack traces: Node/JS ("at fn (file.js:10:5)"), Python, Java.
const STACK_TRACE = /^\s+at .+:\d+(?::\d+)?\)?\s*$|Traceback \(most recent call last\)|Exception in thread "/m;

const ERROR_WORDS = /\b(error|exception|failed|fatal|panic)\b/i;

const GREETING = /^(hi|hello|hey|yo|thanks|thank you|thx|ok|okay|cool|nice|great|yes|no|yep|nope|sure|bye|good (morning|night|evening))\b/i;

// Anything that looks like code: fences, inline code, or code punctuation.
const LOOKS_LIKE_CODE = /```|`[^`]+`|[{};]|=>|\w\(.*\)|<\/?\w+>|^\s*(const|let|var|function|import|SELECT|INSERT)\b/im;

/**
 * @param {string} text the user's message (including any piped context)
 * @param {{
 *   history?: { role: string, content: string }[],
 *   installed?: string[] | null,  // installed model names; null = unknown
 *   models?: typeof config.models,
 *   autoReason?: boolean,  // false = never pick "reason" automatically
 * }} [opts]
 * @returns {{ role: 'coder'|'fast'|'reason', model: string, reason: string }}
 */
export function chooseModel(
  text,
  { history = [], installed = null, models = config.models, autoReason = config.autoReason } = {},
) {
  const pick = (role, reason) => ({ role, model: models[role].name, reason });
  // Unknown install state (e.g. Ollama unreachable): only the default is safe.
  const has = (role) => installed !== null && isModelInstalled(installed, models[role].name);

  const message = String(text ?? '').trim();
  const words = message.split(/\s+/).filter(Boolean);

  // 1. Hard reasoning / debugging
  let reasonSignal = null;
  if (STACK_TRACE.test(message)) reasonSignal = 'stack trace';
  else if (message.length > LONG_ERROR_CHARS && ERROR_WORDS.test(message)) reasonSignal = 'long error output';
  else {
    const match = message.match(REASON_WORDS);
    if (match) reasonSignal = `"${match[0].toLowerCase()}"`;
  }
  if (reasonSignal) {
    if (!autoReason) return pick('coder', `reasoning: ${reasonSignal}, AUTO_REASON off`);
    return has('reason')
      ? pick('reason', `reasoning: ${reasonSignal}`)
      : pick('coder', `reasoning: ${reasonSignal}, ${models.reason.name} not installed`);
  }

  // 2. Short, simple messages
  const isShort = words.length > 0 && words.length < MAX_FAST_WORDS;
  if ((GREETING.test(message) || isShort) && !LOOKS_LIKE_CODE.test(message)) {
    // A short follow-up to a code answer ("and in Python?") still needs the coder.
    const lastReply = [...history].reverse().find((m) => m.role === 'assistant');
    if (lastReply?.content.includes('```')) return pick('coder', 'follow-up on code');
    return has('fast')
      ? pick('fast', 'short message')
      : pick('coder', `short message, ${models.fast.name} not installed`);
  }

  // 3. Everything else
  return pick('coder', 'coding question');
}
