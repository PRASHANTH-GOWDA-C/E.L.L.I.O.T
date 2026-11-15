#!/usr/bin/env node
import { parseArgs, stripVTControlCharacters } from 'node:util';
import config, { VOICES } from '../core/config.js';
import { LlmError, listModels } from '../core/llm.js';
import { chooseModel } from '../core/router.js';
import { Session } from '../core/session.js';
import { runCheck } from '../core/check.js';
import readline from 'node:readline';
import { NotCheckedFixer, colorizeDiff, formatFacts, formatHistory } from '../core/format.js';
import { getMemory, parseFact, projectFor } from '../core/memory.js';
import { createFileTools } from '../core/tools/files.js';
import { runAgent } from '../core/agent.js';
import { ReviewError, audit, formatDebt, formatReport, gitDiff, harvestDebt, review, summarize } from '../core/review.js';
import { collectDoctorReport, formatDoctor } from '../core/doctor.js';

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
  elliot doctor                  Health report: Node, Ollama, models, memory, project

Files (only inside the current folder; nothing is written without your y):
  elliot edit "<instruction>"    Elliot proposes a change, shows the diff, asks y/N
  elliot read <file>             Print a project file
  elliot find "<text>"           Search project files (file:line: text)
  elliot ls [glob]               List project files (respects .gitignore)

Review (Ponytail rules; advice only):
  elliot review [target]         Review changes: uncommitted (default) | staged | branch | <file>
  elliot audit                   Review the most important project files, worst first
  elliot debt [word]             List "shortcut:" comments (or another word) to pay back

Options:
  -m, --model <role>             coder, fast or reason (default: chosen automatically)
      --voice <voice>            plain or alderson (default: ELLIOT_VOICE or plain)
      --new                      Start a new conversation instead of continuing
      --yes                      edit: apply proposed changes without asking
  -h, --help                     Show this help
  -v, --version                  Show the version

Examples:
  elliot --voice alderson
  elliot remember "stack: Node + MySQL"
  elliot edit "add input validation to parseUser in src/users.js"
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

// ---- File commands -------------------------------------------------------------
// Boolean(): isTTY is undefined (not false) when piped; undefined would trigger colorizeDiff's default.
const useStdoutColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/** Throws a UsageError for a failed tool result. */
function check(result) {
  if (!result.ok) throw new UsageError(result.error);
  return result;
}

function read(positionals) {
  if (!positionals[0]) throw new UsageError('read needs a file, e.g. elliot read src/index.js');
  const file = check(createFileTools(process.cwd()).readFile(positionals[0]));
  process.stdout.write(file.content.endsWith('\n') ? file.content : `${file.content}\n`);
  return 0;
}

function find(positionals) {
  const query = positionals.join(' ');
  if (!query.trim()) throw new UsageError('find needs some text, e.g. elliot find "TODO"');
  const { matches, truncated } = check(createFileTools(process.cwd()).searchFiles(query));
  if (matches.length === 0) {
    console.log('No matches.');
    return 1;
  }
  for (const m of matches) console.log(`${m.path}:${m.line}: ${m.text}`);
  if (truncated) console.error(dim('(more matches not shown)'));
  return 0;
}

function ls(positionals) {
  const { files, truncated } = check(createFileTools(process.cwd()).listFiles(positionals[0]));
  for (const f of files) console.log(f);
  if (files.length === 0) console.error(dim('No files.'));
  if (truncated) console.error(dim('(list truncated)'));
  return 0;
}

/**
 * Asks y/N on the terminal. Returns true/false, or null when there is no
 * terminal to ask (piped stdin) — callers must then NOT write.
 */
async function confirm(question) {
  process.stderr.write(question);
  if (!process.stdin.isTTY) {
    process.stderr.write('\n');
    return null;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise((resolve) => {
      rl.on('SIGINT', () => resolve('')); // Ctrl+C = no
      rl.on('close', () => resolve(''));
      rl.question('', resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function edit(positionals, { role, voice }, { yes }) {
  const instruction = positionals.join(' ').trim();
  if (!instruction) throw new UsageError('edit needs an instruction, e.g. elliot edit "rename foo to bar in src/a.js"');

  const files = createFileTools(process.cwd());
  const model = config.models[role ?? 'coder'].name;
  const facts = getMemory().getFacts(projectFor(process.cwd()));
  process.stderr.write(dim(`${model} is looking at ${files.root} …\n`));

  activeController = new AbortController();
  let result;
  try {
    result = await runAgent({
      instruction,
      files,
      model,
      voice,
      facts,
      signal: activeController.signal,
      onEvent: (e) => process.stderr.write(dim(`  → ${e.name} ${e.summary}${e.ok ? '' : `  ✖ ${e.error}`}\n`)),
    });
  } catch (err) {
    if (err instanceof LlmError && err.code === 'ABORTED') {
      process.stderr.write(`${dim('[stopped — nothing was written]')}\n`);
      return 130;
    }
    throw err;
  } finally {
    activeController = null;
  }

  if (result.answer) console.log(`\n${result.answer.trim()}`);
  if (result.proposals.length === 0) {
    console.log(result.fallback ? '\n(This model cannot use file tools; no change was proposed.)' : '\nNo change proposed.');
    return 0;
  }

  let exitCode = 0;
  for (const proposal of result.proposals) {
    const what = proposal.isNew ? 'new file' : `+${proposal.additions} −${proposal.deletions}`;
    console.log(`\nProposed change to ${proposal.absolutePath} (${what})\n`);
    console.log(colorizeDiff(proposal.diff.trimEnd(), useStdoutColor));
    console.log();

    let approved;
    if (yes) {
      process.stderr.write(dim('--yes given: applying without asking\n'));
      approved = true;
    } else {
      approved = await confirm('Apply this change? [y/N] ');
      if (approved === null) {
        console.log('Not applied: no terminal to confirm. Run it in a terminal, or add --yes.');
        exitCode = 1;
        continue;
      }
    }
    if (!approved) {
      console.log('Not applied.');
      continue;
    }

    // Safety rule: always show exactly where we write, before writing.
    console.log(`Writing ${proposal.absolutePath}`);
    const written = files.applyEdit(proposal.path, proposal.newContent, { confirmed: true, baseHash: proposal.baseHash });
    if (written.ok) {
      console.log(`✔ ${written.created ? 'Created' : 'Updated'} ${written.path} (${written.bytes} bytes)`);
    } else {
      console.error(`elliot: not written: ${written.error}`);
      exitCode = 1;
    }
  }
  return exitCode;
}

// ---- Review commands -----------------------------------------------------------
// Advice, not CI: findings never change the exit code. Only failing to run
// (Ollama offline, not a repo…) is reported as an error.

/** Runs a review/audit with Ctrl+C support and live progress on stderr. */
async function withProgress(run) {
  activeController = new AbortController();
  let lastChars = 0;
  const onProgress = (e) => {
    if (e.type === 'tokens') {
      // A live counter on one line (terminals only).
      if (useColor && e.chars - lastChars >= 40) {
        lastChars = e.chars;
        process.stderr.write(dim(`\r    writing findings… ${e.chars} chars`));
      }
      return;
    }
    if (lastChars) process.stderr.write('\r\x1b[K'); // clear the counter line
    lastChars = 0;
    if (e.type === 'chunk' && e.total > 1) process.stderr.write(dim(`  → part ${e.index + 1} of ${e.total}\n`));
    if (e.type === 'batch') process.stderr.write(dim(`  → ${e.files.join(', ')} (${e.index + 1}/${e.total})\n`));
  };
  try {
    return await run({ signal: activeController.signal, onProgress });
  } catch (err) {
    if (err instanceof LlmError && err.code === 'ABORTED') {
      process.stderr.write(`\n${dim('[stopped]')}\n`);
      return null;
    }
    throw err;
  } finally {
    if (useColor) process.stderr.write('\r\x1b[K');
    activeController = null;
  }
}

async function reviewCommand(positionals, { role, voice }) {
  const target = positionals[0] ?? 'uncommitted';
  let input;
  try {
    input = gitDiff(target);
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NO_CHANGES') {
        console.log(`Nothing to review: ${err.message}.`);
        return 0;
      }
      throw new UsageError(err.message);
    }
    throw err;
  }
  const model = config.models[role ?? 'coder'].name;
  process.stderr.write(dim(`Reviewing ${input.description} (${input.files.length} file${input.files.length === 1 ? '' : 's'}) with ${model} …\n`));
  const started = performance.now();
  const result = await withProgress((p) => review(input, { model, voice, ...p }));
  if (!result) return 130;
  console.log(formatReport(result, { color: useStdoutColor, title: `Review of ${input.description}` }));
  process.stderr.write(dim(`\n${model} · ${((performance.now() - started) / 1000).toFixed(1)}s\n`));
  return 0;
}

async function auditCommand({ role, voice }) {
  const model = config.models[role ?? 'coder'].name;
  process.stderr.write(dim(`Auditing ${process.cwd()} with ${model} (the most important files only) …\n`));
  const started = performance.now();
  const result = await withProgress((p) => audit({ model, voice, ...p }));
  if (!result) return 130;
  // One-line summary first, then the details.
  console.log(`${summarize(result.findings)} — ${result.reviewed.length} of ${result.totalSource} source files reviewed`);
  console.log(formatReport(result, { color: useStdoutColor }));
  process.stderr.write(dim(`\n${model} · ${((performance.now() - started) / 1000).toFixed(1)}s\n`));
  return 0;
}

function debtCommand(positionals) {
  const word = positionals[0] ?? 'shortcut';
  let items;
  try {
    items = harvestDebt({ word });
  } catch (err) {
    throw new UsageError(err.message);
  }
  console.log(formatDebt(items, word));
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
        yes: { type: 'boolean' },
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
    case 'edit':
      return edit(rest, opts, { yes: values.yes ?? false });
    case 'read':
      return read(rest);
    case 'find':
      return find(rest);
    case 'ls':
      return ls(rest);
    case 'review':
      return reviewCommand(rest, opts);
    case 'audit':
      return auditCommand(opts);
    case 'debt':
      return debtCommand(rest);
    case 'models':
      return runCheck();
    case 'doctor': {
      const { text, problems } = formatDoctor(await collectDoctorReport());
      console.log(text);
      return problems ? 1 : 0;
    }
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
