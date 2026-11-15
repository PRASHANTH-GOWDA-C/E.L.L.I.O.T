#!/usr/bin/env node
import { parseArgs, stripVTControlCharacters } from 'node:util';
import config, { VOICES } from '../core/config.js';
import { LlmError, listModels } from '../core/llm.js';
import { chooseModel } from '../core/router.js';
import { Session } from '../core/session.js';
import { runCheck } from '../core/check.js';
import { NotCheckedFixer, formatFacts, formatHistory } from '../core/format.js';
import { getMemory, parseFact, projectFor } from '../core/memory.js';

const MAX_PIPED_CHARS = 12_000; // keeps piped logs inside a small context window
const EXPLAIN_PROMPT = 'Explain this output and how to fix it.';
const ROLES = ['coder', 'fast', 'reason'];

const HELP = `E.L.L.I.O.T v${config.version} – offline coding companion

Usage:
  elliot                         Open the full-screen chat (continues this project's last chat)
  elliot ask "<question>"        Ask Elliot; the answer streams as it arrives
  <command> | elliot ask "<q>"   Include piped output as context
  <command> | elliot explain     Explain piped output and how to fix it (not saved)
  elliot history                 List this project's past conversations
  elliot resume <id>             Open the full-screen chat on conversation <id>
  elliot remember "key: value"   Save a note about this project
  elliot facts                   List this project's notes
  elliot models                  Check Ollama and the required models

Options:
  -m, --model <role>             coder, fast or reason (default: chosen automatically)
      --voice <voice>            plain or alderson (default: ELLIOT_VOICE or plain)
      --new                      Start a new conversation instead of continuing
  -h, --help                     Show this help
  -v, --version                  Show the version

Examples:
  elliot --voice alderson
  elliot remember "stack: Node + MySQL"
  elliot ask "Write a JS function that reverses a string"
  npm test 2>&1 | elliot ask -m reason "what broke?"
  node app.js 2>&1 | elliot explain`;

const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const dim = (text) => (useColor ? `\x1b[2m${text}\x1b[22m` : text);

class UsageError extends Error {}

// ---- Ctrl+C handling -------------------------------------------------------
// First Ctrl+C cancels the running reply; a second one (or Ctrl+C while no
// reply is running) exits immediately.
let activeController = null;
process.on('SIGINT', () => {
  if (activeController && !activeController.signal.aborted) {
    activeController.abort();
  } else {
    process.stderr.write('\n');
    process.exit(130);
  }
});

// `elliot ask ... | head` closes stdout early – exit quietly instead of crashing.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

// ---- Piped input -------------------------------------------------------------
async function readPipedInput() {
  if (process.stdin.isTTY) return '';

  // Some terminals report a pipe even when nothing is piped; tell the user why we wait.
  const hint = setTimeout(() => {
    process.stderr.write(dim('(waiting for piped input… press Ctrl+C to cancel)\n'));
  }, 3_000);

  let data = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
  } finally {
    clearTimeout(hint);
  }

  data = stripVTControlCharacters(data).trim();
  if (data.length > MAX_PIPED_CHARS) {
    // Errors are usually at the end of a log, so keep the tail.
    const omitted = data.length - MAX_PIPED_CHARS;
    data = `[… first ${omitted} characters omitted …]\n${data.slice(-MAX_PIPED_CHARS)}`;
  }
  return data;
}

function withContext(piped, question) {
  if (!piped) return question;
  return `Here is the output I'm looking at:\n\n\`\`\`\n${piped}\n\`\`\`\n\n${question}`;
}

// ---- Chat commands -----------------------------------------------------------
/** Manual -m choice wins; otherwise the router picks from the message (and history). */
async function resolveModel(message, manualRole, history) {
  if (manualRole) {
    return { model: config.models[manualRole].name, label: `manual: ${manualRole}` };
  }
  // The router only picks reason/fast if installed. If Ollama is unreachable it
  // falls back to coder, and the chat request then reports the real error.
  const installed = await listModels().catch(() => null);
  const choice = chooseModel(message, { history, installed });
  return { model: choice.model, label: `auto: ${choice.role} (${choice.reason})` };
}

/**
 * @param {string} message full message sent to the model
 * @param {{ role?: string, voice: string, fresh: boolean }} opts
 * @param {{ remember: boolean, title?: string }} memoryOpts
 */
async function streamAnswer(message, { role, voice, fresh }, { remember, title }) {
  const memory = remember ? getMemory() : null;
  const session = new Session({ voice, memory, continue: !fresh });
  const { model: chosenModel, label } = await resolveModel(message, role, session.history);
  session.model = chosenModel;
  activeController = new AbortController();

  const stream = session.send(message, { signal: activeController.signal, title });
  const fixer = new NotCheckedFixer();
  let endsWithNewline = true;
  const write = (text) => {
    if (!text) return;
    process.stdout.write(text);
    endsWithNewline = text.endsWith('\n');
  };

  let result;
  try {
    while (!(result = await stream.next()).done) write(fixer.push(result.value));
    write(fixer.end());
  } catch (err) {
    if (err instanceof LlmError && err.code === 'ABORTED') {
      write(fixer.end());
      process.stderr.write(`${endsWithNewline ? '' : '\n'}${dim('[stopped]')}\n`);
      return 130;
    }
    if (!endsWithNewline) process.stdout.write('\n');
    throw err;
  } finally {
    activeController = null;
  }

  if (!endsWithNewline) process.stdout.write('\n');
  const { model, ms, tokensPerSec, chars } = result.value;
  const speed = tokensPerSec !== null ? `${tokensPerSec} tok/s` : `${chars} chars`;
  const saved = session.conversationId ? ` · chat #${session.conversationId}` : '';
  process.stderr.write(`${dim(`\n${model} · ${label} · ${(ms / 1000).toFixed(1)}s · ${speed}${saved}`)}\n`);
  return 0;
}

async function ask(positionals, opts) {
  const question = positionals.join(' ').trim();
  if (!question) throw new UsageError('ask needs a question, e.g. elliot ask "how do I read a file in Node?"');
  const piped = await readPipedInput();
  return streamAnswer(withContext(piped, question), opts, { remember: true, title: question });
}

// explain is a one-off: big pasted logs would crowd out the conversation memory.
async function explain(positionals, opts) {
  const piped = await readPipedInput();
  if (!piped) throw new UsageError('explain needs piped input, e.g. npm test 2>&1 | elliot explain');
  const extra = positionals.join(' ').trim();
  const prompt = extra ? `${EXPLAIN_PROMPT} ${extra}` : EXPLAIN_PROMPT;
  return streamAnswer(withContext(piped, prompt), { ...opts, fresh: true }, { remember: false });
}

async function fullScreen({ role, voice, fresh, conversationId }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError('full-screen mode needs an interactive terminal — try: elliot ask "hello"');
  }
  // Loaded lazily so `elliot ask` doesn't pay for React/Ink startup.
  const { runTui } = await import('./tui/index.js');
  await runTui({ role, voice, fresh, conversationId });
  return 0;
}

// ---- Memory commands ---------------------------------------------------------
function history() {
  const project = projectFor(process.cwd());
  const conversations = getMemory().listConversations(project);
  if (conversations.length === 0) {
    console.log('No conversations for this project yet.');
    return 0;
  }
  console.log(`Conversations for ${process.cwd()}\n`);
  console.log(formatHistory(conversations));
  console.log(dim('\nResume one with: elliot resume <id>'));
  return 0;
}

function resume(positionals, opts) {
  const id = Number(positionals[0]);
  if (!Number.isInteger(id) || id <= 0) throw new UsageError('resume needs a conversation id — see: elliot history');
  if (!getMemory().getConversation(id)) throw new UsageError(`no conversation #${id} — see: elliot history`);
  return fullScreen({ ...opts, conversationId: id });
}

function remember(positionals) {
  const fact = parseFact(positionals.join(' '));
  if (!fact) throw new UsageError('remember needs "key: value", e.g. elliot remember "stack: Node + MySQL"');
  const project = projectFor(process.cwd());
  if (!getMemory().saveFact(project, fact.key, fact.value)) return 1; // warning already printed
  console.log(`Remembered for ${process.cwd()}: ${fact.key} = ${fact.value}`);
  return 0;
}

function facts() {
  const project = projectFor(process.cwd());
  const list = getMemory().getFacts(project);
  if (list.length === 0) {
    console.log('No notes for this project yet — try: elliot remember "stack: Node + MySQL"');
    return 0;
  }
  console.log(`Notes for ${process.cwd()}\n`);
  console.log(formatFacts(list));
  return 0;
}

// ---- Entry point -------------------------------------------------------------
async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        model: { type: 'string', short: 'm' },
        voice: { type: 'string' },
        new: { type: 'boolean' },
      },
    });
  } catch (err) {
    throw new UsageError(err.message);
  }

  const { values, positionals } = parsed;
  const role = values.model; // undefined = automatic
  if (role !== undefined && !ROLES.includes(role)) {
    throw new UsageError(`unknown model role "${role}" — use one of: ${ROLES.join(', ')}`);
  }
  const voice = values.voice ?? config.voice;
  if (!VOICES.includes(voice)) {
    throw new UsageError(`unknown voice "${voice}" — use one of: ${VOICES.join(', ')}`);
  }
  const opts = { role, voice, fresh: values.new ?? false };
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(config.version);
    return 0;
  }

  const [command, ...rest] = positionals;
  switch (command) {
    case undefined:
      return fullScreen(opts);
    case 'ask':
      return ask(rest, opts);
    case 'explain':
      return explain(rest, opts);
    case 'history':
      return history();
    case 'resume':
      return resume(rest, opts);
    case 'remember':
      return remember(rest);
    case 'facts':
      return facts();
    case 'models':
      return runCheck();
    default:
      throw new UsageError(`unknown command "${command}" — run elliot --help`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof LlmError || err instanceof UsageError) {
    console.error(`elliot: ${err.message}`);
  } else {
    console.error(`elliot: unexpected error: ${err.message}`);
    if (process.env.ELLIOT_DEBUG) console.error(err);
  }
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
