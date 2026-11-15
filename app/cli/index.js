#!/usr/bin/env node
import { parseArgs, stripVTControlCharacters } from 'node:util';
import config from '../core/config.js';
import { LlmError } from '../core/llm.js';
import { Session } from '../core/session.js';
import { runCheck } from '../core/check.js';

const MAX_PIPED_CHARS = 12_000; // keeps piped logs inside a small context window
const EXPLAIN_PROMPT = 'Explain this output and how to fix it.';

const HELP = `E.L.L.I.O.T v${config.version} – offline coding companion

Usage:
  elliot ask "<question>"        Ask Elliot; the answer streams as it arrives
  <command> | elliot ask "<q>"   Include piped output as context
  <command> | elliot explain     Explain piped output and how to fix it
  elliot models                  Check Ollama and the required models

Options:
  -h, --help                     Show this help
  -v, --version                  Show the version

Examples:
  elliot ask "Write a JS function that reverses a string"
  npm test 2>&1 | elliot ask "what broke?"
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
async function streamAnswer(message) {
  const session = new Session();
  activeController = new AbortController();

  const stream = session.send(message, { signal: activeController.signal });
  let endsWithNewline = true;
  let result;
  try {
    while (!(result = await stream.next()).done) {
      process.stdout.write(result.value);
      endsWithNewline = result.value.endsWith('\n');
    }
  } catch (err) {
    if (err instanceof LlmError && err.code === 'ABORTED') {
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

async function ask(positionals) {
  const question = positionals.join(' ').trim();
  if (!question) throw new UsageError('ask needs a question, e.g. elliot ask "how do I read a file in Node?"');
  const piped = await readPipedInput();
  return streamAnswer(withContext(piped, question));
}

async function explain(positionals) {
  const piped = await readPipedInput();
  if (!piped) throw new UsageError('explain needs piped input, e.g. npm test 2>&1 | elliot explain');
  const extra = positionals.join(' ').trim();
  return streamAnswer(withContext(piped, extra ? `${EXPLAIN_PROMPT} ${extra}` : EXPLAIN_PROMPT));
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
      },
    });
  } catch (err) {
    throw new UsageError(err.message);
  }

  const { values, positionals } = parsed;
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
      console.log('Full-screen mode is coming in the next step — try: elliot ask "hello"');
      return 0;
    case 'ask':
      return ask(rest);
    case 'explain':
      return explain(rest);
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
