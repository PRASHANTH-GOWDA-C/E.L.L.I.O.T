// Tool-calling loop: lets the coder model look at project files and propose
// edits. It can NOT write: the only tools are read_file, list_files,
// search_files and propose_edit (which returns a diff). Writing happens
// outside this module, in applyEdit, after the user confirms.
//
// Small local models format tool calls imperfectly, so this accepts:
//   • native OpenAI-style tool_calls (arguments as a JSON string or object)
//   • a JSON tool call written in the reply text (bare, in ```json fences, or
//     in <tool_call> tags), with minor JSON mistakes repaired
// and falls back to a plain answer if the model can't use tools at all.
import config from './config.js';
import { LlmError, chat, chatWithTools } from './llm.js';
import { buildSystemPrompt } from './persona.js';
import { checkSyntax } from './tools/syntax.js';

const MAX_ITERATIONS = 6;
const MAX_TOOL_FILE_CHARS = 8_000; // keeps tool results inside a small context window
const MAX_TOOL_LIST = 200;
const MAX_TOOL_MATCHES = 50;

export const TOOL_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the project. Path is relative to the project folder.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'e.g. "src/index.js"' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List project files (respects .gitignore). Optional glob such as "*.js" or "src/**/*.ts".',
      parameters: { type: 'object', properties: { glob: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search project files for text. Returns file:line matches.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, glob: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_edit',
      description:
        'Propose a change to one file. Does NOT write: the user sees a diff and decides. ' +
        'For small changes give old_text (copied exactly from the file, must appear once) and new_text. ' +
        'For a new file or a full rewrite give content (the complete new file).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
];

const TOOL_NAMES = new Set(TOOL_SCHEMA.map((t) => t.function.name));

const TOOL_INSTRUCTIONS = `
Tools: you can look at and change files in this project with read_file, list_files, search_files and propose_edit. Paths are relative to the project folder.
- To change a file you MUST call read_file first, then propose_edit. Do not paste code in your reply: changes only happen through propose_edit.
- Prefer old_text/new_text for small changes; old_text must be copied exactly from the file.
- propose_edit does NOT write anything. The user reviews a diff and decides. Never claim that a file was changed.
- Call one tool at a time. When you have proposed the edit, stop and summarise it in one sentence.`;

// Sent once if the model pastes code or asks for files instead of using the tools.
const USE_TOOLS_NUDGE =
  'You can read the project files yourself, so do not ask me for them, and do not paste code. ' +
  'Call read_file on the file, then propose_edit with the change. Reply with a tool call only.';

// ---- Lenient parsing ---------------------------------------------------------

/**
 * The first balanced {...} or [...] in text, honouring strings — so extra
 * closing braces after it ("…}}}") are ignored.
 */
function firstBalanced(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** JSON.parse that repairs common small-model mistakes. Returns undefined if hopeless. */
export function parseLooseJson(text) {
  if (text !== null && typeof text === 'object') return text;
  if (typeof text !== 'string') return undefined;
  const attempts = [];
  const trimmed = text.trim();
  attempts.push(trimmed);
  const balanced = firstBalanced(trimmed);
  if (balanced) attempts.push(balanced);
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (start !== -1 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const base of [...attempts]) {
    const fixed = base
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1') // trailing commas
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null');
    attempts.push(fixed);
    // Single-quoted keys/strings → double quotes (only tried if the rest fails).
    attempts.push(fixed.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, s) => JSON.stringify(s.replace(/\\'/g, "'"))));
  }
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

/** Normalises the many shapes a "tool call" object can take. */
function toCall(obj, id) {
  if (!obj || typeof obj !== 'object') return null;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj;
  const name = fn.name ?? obj.tool ?? obj.tool_name;
  if (typeof name !== 'string' || !TOOL_NAMES.has(name)) return null;
  const rawArgs = fn.arguments ?? fn.parameters ?? obj.args ?? obj.arguments ?? obj.parameters ?? {};
  const args = parseLooseJson(rawArgs);
  return args && typeof args === 'object' && !Array.isArray(args)
    ? { id, name, args }
    : { id, name, args: null, error: 'tool arguments were not valid JSON' };
}

/**
 * Extracts tool calls from an assistant message.
 * @returns {{ calls: { id, name, args, error? }[], native: boolean }}
 */
export function parseToolCalls(message) {
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    const calls = message.tool_calls.map((tc, i) => {
      const call = toCall(tc, tc.id ?? `call_${i}`);
      return call ?? { id: tc.id ?? `call_${i}`, name: tc.function?.name ?? '?', args: null, error: 'unknown tool' };
    });
    return { calls, native: true };
  }

  // Tool calls written as text.
  const content = typeof message?.content === 'string' ? message.content : '';
  const candidates = [];
  for (const m of content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) candidates.push(m[1]);
  for (const m of content.matchAll(/```(?:json|tool_call)?\s*\n([\s\S]*?)```/g)) candidates.push(m[1]);
  if (candidates.length === 0 && /^\s*[[{]/.test(content)) candidates.push(content);
  if (candidates.length === 0) {
    // A bare call after some prose: 'I will read it.\n{"name": "read_file", …}'.
    for (const m of content.matchAll(/\{\s*"(?:name|function|tool)"\s*:/g)) {
      const object = firstBalanced(content.slice(m.index));
      if (object) candidates.push(object);
    }
  }

  const calls = [];
  for (const candidate of candidates) {
    const parsed = parseLooseJson(candidate);
    if (parsed === undefined) {
      // Unparseable, but clearly meant as a call to one of our tools: tell the model.
      const named = candidate.match(/"name"\s*:\s*"([a-z_]+)"/);
      if (named && TOOL_NAMES.has(named[1])) {
        calls.push({ id: `text_call_${calls.length}`, name: named[1], args: null, error: 'tool call was not valid JSON' });
      }
      continue;
    }
    for (const obj of Array.isArray(parsed) ? parsed : [parsed]) {
      const call = toCall(obj, `text_call_${calls.length}`);
      if (call) calls.push(call);
    }
  }
  return { calls, native: false };
}

/** Reply text with any written-out tool calls removed (they're not meant for the user). */
function stripToolText(content) {
  let stripped = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/```(?:json|tool_call)?\s*\n[\s\S]*?```/g, '');
  // Bare call objects after prose.
  for (let m; (m = stripped.match(/\{\s*"(?:name|function|tool)"\s*:/)); ) {
    const object = firstBalanced(stripped.slice(m.index));
    if (!object) break;
    stripped = stripped.slice(0, m.index) + stripped.slice(m.index + object.length);
  }
  // Leftover brace-only lines (models often add an extra "}" after a call).
  stripped = stripped.replace(/^[\s{}[\]]+$/gm, '').trim();
  return /^\s*[[{]/.test(stripped) ? '' : stripped;
}

// ---- Tools -------------------------------------------------------------------

function clip(text, max) {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/**
 * Runs the agent for one instruction.
 * @param {{
 *   instruction: string,
 *   files: ReturnType<import('./tools/files.js').createFileTools>,
 *   model?: string, cwd?: string, voice?: string, facts?: object[],
 *   signal?: AbortSignal,
 *   onEvent?: (event: { type: 'tool', name: string, summary: string, ok: boolean, error?: string }) => void,
 *   chatFn?: typeof chatWithTools, plainChatFn?: typeof chat, maxIterations?: number,
 * }} opts
 * @returns {Promise<{ answer: string, proposals: object[], fallback: boolean }>}
 *   proposals: results of files.proposeEdit (with diff) — nothing has been written
 */
export async function runAgent({
  instruction,
  files,
  model = config.models.coder.name,
  cwd = files.root,
  voice = config.voice,
  facts = [],
  signal,
  onEvent = () => {},
  chatFn = chatWithTools,
  plainChatFn = chat,
  maxIterations = MAX_ITERATIONS,
}) {
  if (typeof instruction !== 'string' || instruction.trim() === '') throw new TypeError('instruction must be a non-empty string');

  const system = { role: 'system', content: `${buildSystemPrompt({ cwd, voice, facts, mode: 'tools' })}\n${TOOL_INSTRUCTIONS}` };
  let nudged = false;
  let toolCallsSeen = 0;
  const messages = [system, { role: 'user', content: instruction }];
  const proposals = [];
  // Files read in full during this run; full-content rewrites are only allowed for these.
  const fullyRead = new Set();

  const runTool = ({ name, args }) => {
    switch (name) {
      case 'read_file': {
        const r = files.readFile(args.path);
        if (!r.ok) return r;
        const { text, truncated } = clip(r.content, MAX_TOOL_FILE_CHARS);
        if (!truncated) fullyRead.add(r.path);
        return { ok: true, path: r.path, content: text, truncated, note: truncated ? 'File truncated: use old_text/new_text edits.' : undefined };
      }
      case 'list_files': {
        const r = files.listFiles(args.glob);
        if (!r.ok) return r;
        return { ok: true, files: r.files.slice(0, MAX_TOOL_LIST), truncated: r.truncated || r.files.length > MAX_TOOL_LIST };
      }
      case 'search_files': {
        const r = files.searchFiles(args.query, { glob: args.glob });
        if (!r.ok) return r;
        return { ok: true, matches: r.matches.slice(0, MAX_TOOL_MATCHES), truncated: r.truncated || r.matches.length > MAX_TOOL_MATCHES };
      }
      case 'propose_edit':
        return proposeFromArgs(args);
      default:
        return { ok: false, code: 'UNKNOWN_TOOL', error: `unknown tool ${name}` };
    }
  };

  function proposeFromArgs(args) {
    if (typeof args.path !== 'string') return { ok: false, code: 'BAD_ARGS', error: 'propose_edit needs a path' };
    let newContent;
    if (typeof args.old_text === 'string' && typeof args.new_text === 'string') {
      const current = files.readFile(args.path);
      if (!current.ok) return current;
      // Match on "\n" line endings; proposeEdit restores the file's own endings.
      const text = current.content.replace(/\r\n/g, '\n');
      const oldText = args.old_text.replace(/\r\n/g, '\n');
      if (oldText === '') return { ok: false, code: 'BAD_ARGS', error: 'old_text is empty' };
      const count = text.split(oldText).length - 1;
      if (count === 0) return { ok: false, code: 'NO_MATCH', error: 'old_text was not found in the file; read_file and copy it exactly' };
      if (count > 1) return { ok: false, code: 'AMBIGUOUS', error: `old_text appears ${count} times; include more surrounding lines` };
      newContent = text.replace(oldText, () => args.new_text.replace(/\r\n/g, '\n'));
    } else if (typeof args.content === 'string') {
      const resolved = files.resolvePath(args.path);
      if (!resolved.ok) return resolved;
      const exists = files.readFile(args.path).code !== 'NOT_FOUND';
      // Never let a model rewrite a file it hasn't fully seen (it would drop the parts it didn't read).
      if (exists && !fullyRead.has(resolved.rel)) {
        return { ok: false, code: 'READ_FIRST', error: `call read_file on ${resolved.rel} before replacing its whole content, or use old_text/new_text` };
      }
      newContent = args.content;
    } else {
      return { ok: false, code: 'BAD_ARGS', error: 'propose_edit needs old_text and new_text, or content' };
    }

    const proposal = files.proposeEdit(args.path, newContent);
    if (!proposal.ok) return proposal;
    if (!proposal.changed) return { ok: false, code: 'NO_CHANGE', error: 'the proposed content is identical to the file' };

    // Never show an edit that breaks a file which parsed before (e.g. a lost closing brace).
    const broken = checkSyntax(proposal.path, proposal.newContent);
    if (broken) {
      const before = files.readFile(proposal.path);
      const wasValid = !before.ok || checkSyntax(proposal.path, before.content) === null;
      if (wasValid) {
        return {
          ok: false,
          code: 'SYNTAX_ERROR',
          error: `this edit would break ${proposal.path}: ${broken}. Keep every other line (including closing braces) and call propose_edit again.`,
        };
      }
    }
    proposals.push(proposal);
    return { ok: true, message: 'Diff shown to the user. Waiting for their decision; nothing was written. Do not call more tools.' };
  }

  const summarize = (call) => {
    const a = call.args ?? {};
    return [a.path, a.glob, a.query && `"${a.query}"`].filter(Boolean).join(' ') || '';
  };

  let lastContent = '';
  for (let i = 0; i < maxIterations; i++) {
    let message;
    try {
      message = await chatFn({ model, messages, tools: TOOL_SCHEMA, signal });
    } catch (err) {
      if (err instanceof LlmError && err.code === 'TOOLS_UNSUPPORTED') {
        // The model can't call tools: answer without them.
        const answer = await plainChatFn({ model, messages: [system, { role: 'user', content: instruction }] });
        return { answer, proposals, fallback: true };
      }
      throw err;
    }

    lastContent = typeof message.content === 'string' ? message.content : '';
    const { calls, native } = parseToolCalls(message);
    if (calls.length === 0) {
      // Pasted code, or answered without looking at any file (e.g. "please send me the file")?
      // Remind it once that it has tools.
      const skippedTools = toolCallsSeen === 0 || lastContent.includes('```');
      if (!nudged && proposals.length === 0 && skippedTools && i + 1 < maxIterations) {
        nudged = true;
        messages.push({ role: 'assistant', content: lastContent }, { role: 'user', content: USE_TOOLS_NUDGE });
        onEvent({ type: 'tool', name: 'reminder', summary: 'asked the model to use its file tools', ok: true });
        continue;
      }
      return { answer: lastContent, proposals, fallback: false };
    }
    toolCallsSeen += calls.length;

    // Record the assistant turn, then each tool result.
    if (native) {
      messages.push({
        role: 'assistant',
        content: lastContent,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      });
    } else {
      messages.push({ role: 'assistant', content: lastContent });
    }

    for (const call of calls) {
      const result = call.error ? { ok: false, code: 'BAD_TOOL_CALL', error: `${call.error}. Send the call again as valid JSON.` } : runTool(call);
      onEvent({ type: 'tool', name: call.name, summary: summarize(call), ok: result.ok, error: result.error });
      const content = JSON.stringify(result);
      messages.push(
        native
          ? { role: 'tool', tool_call_id: call.id, content }
          : { role: 'user', content: `Result of ${call.name}: ${content}` },
      );
    }

    // An edit was proposed: pause here for the user's decision.
    if (proposals.length > 0) return { answer: native ? lastContent.trim() : stripToolText(lastContent), proposals, fallback: false };
  }

  return {
    answer: lastContent || `Stopped after ${maxIterations} tool steps without finishing.`,
    proposals,
    fallback: false,
  };
}
