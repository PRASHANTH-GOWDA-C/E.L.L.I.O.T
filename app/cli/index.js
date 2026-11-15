#!/usr/bin/env node
import { parseArgs, stripVTControlCharacters } from 'node:util';
import config from '../core/config.js';
import { LlmError } from '../core/llm.js';
import { Session } from '../core/session.js';
import { runCheck } from '../core/check.js';
import { NotCheckedFixer } from '../core/format.js';

const MAX_PIPED_CHARS = 12_000; // keeps piped logs inside a small context window
const EXPLAIN_PROMPT = 'Explain this output and how to fix it.';
const ROLES = ['coder', 'fast', 'reason'];

const HELP = `E.L.L.I.O.T v${config.version} – offline coding companion

Usage:
  elliot                         Open the full-screen chat
  elliot ask "<question>"        Ask Elliot; the answer streams as it arrives
  <command> | elliot ask "<q>"   Include piped output as context
  <command> | elliot explain     Explain piped output and how to fix it
  elliot models                  Check Ollama and the required models

Options:
  -m, --model <role>             coder (default), fast or reason
  -h, --help                     Show this help
  -v, --version                  Show the version

Examples:
  elliot -m fast
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

// ---- Commands ----------------------------------------------------------------
async function streamAnswer(message, role) {
  const session = new Session({ model: config.models[role].name });
  activeController = new AbortController();

  const stream = session.send(message, { signal: activeController.signal });
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
  process.stderr.write(`${dim(`\n${model} · ${(ms / 1000).toFixed(1)}s · ${speed}`)}\n`);
  return 0;
}

async function ask(positionals, role) {
  const question = positionals.join(' ').trim();
  if (!question) throw new UsageError('ask needs a question, e.g. elliot ask "how do I read a file in Node?"');
  const piped = await readPipedInput();
  return streamAnswer(withContext(piped, question), role);
}

async function explain(positionals, role) {
  const piped = await readPipedInput();
  if (!piped) throw new UsageError('explain needs piped input, e.g. npm test 2>&1 | elliot explain');
  const extra = positionals.join(' ').trim();
  return streamAnswer(withContext(piped, extra ? `${EXPLAIN_PROMPT} ${extra}` : EXPLAIN_PROMPT), role);
}

async function fullScreen(role) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError('full-screen mode needs an interactive terminal — try: elliot ask "hello"');
  }
  // Loaded lazily so `elliot ask` doesn't pay for React/Ink startup.
  const { runTui } = await import('./tui/index.js');
  await runTui({ role });
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
        model: { type: 'string', short: 'm', default: 'coder' },
      },
    });
  } catch (err) {
    throw new UsageError(err.message);
  }

  const { values, positionals } = parsed;
  const role = values.model;
  if (!ROLES.includes(role)) {
    throw new UsageError(`unknown model role "${role}" — use one of: ${ROLES.join(', ')}`);
  }
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
      return fullScreen(role);
    case 'ask':
      return ask(rest, role);
    case 'explain':
      return explain(rest, role);
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
