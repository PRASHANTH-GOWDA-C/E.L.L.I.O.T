// `npm run e2e`: end-to-end smoke test of Elliot's core, without a model.
//
// Builds a small buggy git project in a temp folder, then drives the real
// memory, file tools, agent loop, confirmed edits, git review and debt
// harvest — stubbing only the LLM replies (a real model is too slow here).
// Also runs the real `elliot` CLI for the commands that need no model.
//
//   npm run e2e            run and clean up
//   npm run e2e -- --keep  keep the temp project (for a manual real-model run)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Memory, projectFor } from '../app/core/memory.js';
import { Session } from '../app/core/session.js';
import { createFileTools } from '../app/core/tools/files.js';
import { runAgent } from '../app/core/agent.js';
import { formatReport, gitDiff, harvestDebt, review } from '../app/core/review.js';

const ELLIOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ELLIOT_ROOT, 'app', 'cli', 'index.js');
const keep = process.argv.includes('--keep');

// ---- The buggy sample project ---------------------------------------------------
export const SAMPLE = {
  'package.json': JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/cart.js': `// Adds up the price of every item in a cart.
// shortcut: prices are trusted to be numbers
export function cartTotal(items) {
  let total = 0;
  for (let i = 0; i < items.length - 1; i++) {
    total += items[i].price;
  }
  return total;
}
`,
  'test/cart.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from '../src/cart.js';

test('adds every item', () => {
  assert.equal(cartTotal([{ price: 2 }, { price: 3 }, { price: 5 }]), 10);
});

test('an empty cart costs nothing', () => {
  assert.equal(cartTotal([]), 0);
});
`,
  '.gitignore': 'node_modules/\n',
};

const OFF_BY_ONE = 'i < items.length - 1';
const FIXED = 'i < items.length';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elliot-e2e-'));
  for (const [rel, content] of Object.entries(SAMPLE)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'Elliot e2e');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'buggy cart');
  return dir;
}

const runProjectTests = (dir) => spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8' });
const runCli = (dir, args, input) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', input: input ?? '', env: { ...process.env, NO_COLOR: '1' } });

// Fake model streams / chat turns.
async function* fakeStream({ model }) {
  yield 'Noted.';
  return { model, ms: 1, chars: 6, tokens: 2, tokensPerSec: 2000 };
}
const scripted = (...replies) => async () => replies.shift() ?? { content: 'done' };
const toolCall = (name, args) => ({
  content: '',
  tool_calls: [{ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

// ---- Steps ----------------------------------------------------------------------
const results = [];
async function step(name, fn) {
  const started = performance.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: performance.now() - started });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, ms: performance.now() - started, error: err });
    console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').join('\n        ')}`);
  }
}

const dir = makeProject();
const memoryFile = path.join(dir, '.e2e-memory', 'elliot.db'); // fresh DB: "first run"
const memory = new Memory({ file: memoryFile, onWarn: (w) => console.log(`        memory warning: ${w}`) });
const files = createFileTools(dir);
let proposal;

console.log(`E.L.L.I.O.T end-to-end smoke test\nproject: ${dir}\n`);
try {
  await step('sample project starts with a failing test', () => {
    const r = runProjectTests(dir);
    assert.notEqual(r.status, 0, 'expected the buggy project to fail its tests');
    assert.match(r.stdout, /adds every item/);
  });

  await step('memory: first run creates the database', () => {
    assert.equal(fs.existsSync(memoryFile), false);
    assert.equal(memory.saveFact(projectFor(dir), 'stack', 'Node 22 + node:test'), true);
    assert.equal(fs.existsSync(memoryFile), true);
    assert.equal(memory.temporary, false);
  });

  await step('memory: a chat is saved and continued in a new session', async () => {
    const first = new Session({ cwd: dir, memory, continue: true, stream: fakeStream });
    assert.match(first.system.content, /- stack: Node 22 \+ node:test/, 'facts in the system prompt');
    const gen = first.send('Why does cartTotal return 5 for three items?');
    while (!(await gen.next()).done);
    const second = new Session({ cwd: dir, memory, continue: true, stream: fakeStream });
    assert.equal(second.conversationId, first.conversationId);
    assert.deepEqual(second.history.map((m) => m.role), ['user', 'assistant']);
    assert.equal(memory.search(projectFor(dir), 'three items').messages.length, 1);
  });

  await step('files: list respects .gitignore, read and search work', () => {
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'ignored');
    const listed = files.listFiles('*.js').files;
    assert.deepEqual(listed, ['src/cart.js', 'test/cart.test.js']);
    assert.match(files.readFile('src/cart.js').content, /cartTotal/);
    const hits = files.searchFiles('items.length').matches;
    assert.deepEqual(hits.map((h) => `${h.path}:${h.line}`), ['src/cart.js:5']);
  });

  await step('files: escapes and secrets are refused', () => {
    assert.equal(files.readFile('../outside.txt').code, 'OUTSIDE_PROJECT');
    assert.equal(files.readFile('.git/config').code, 'FORBIDDEN');
    assert.equal(files.applyEdit('../evil.js', 'x', { confirmed: true }).code, 'OUTSIDE_PROJECT');
  });

  await step('agent: proposes the off-by-one fix as a diff (stubbed model), nothing written', async () => {
    const result = await runAgent({
      instruction: 'fix the off-by-one bug in src/cart.js',
      files,
      chatFn: scripted(
        toolCall('read_file', { path: 'src/cart.js' }),
        // Written as text with an extra "}" — the shape small models really produce.
        { content: `\`\`\`json\n{"name": "propose_edit", "arguments": {"path": "src/cart.js", "old_text": "${OFF_BY_ONE}", "new_text": "${FIXED}"}}}\n\`\`\`` },
      ),
    });
    assert.equal(result.proposals.length, 1);
    proposal = result.proposals[0];
    assert.match(proposal.diff, new RegExp(`-  for \\(let i = 0; ${OFF_BY_ONE.replace(/[.()]/g, '\\$&')}; i\\+\\+\\) \\{`));
    assert.match(proposal.diff, /\+  for \(let i = 0; i < items\.length; i\+\+\) \{/);
    assert.match(files.readFile('src/cart.js').content, /items\.length - 1/, 'still unchanged on disk');
  });

  await step('edit: refused without confirmation, written after "y", tests now pass', async () => {
    assert.equal(files.applyEdit(proposal.path, proposal.newContent).code, 'NOT_CONFIRMED');
    assert.notEqual(runProjectTests(dir).status, 0);
    const answer = 'y'; // the user's answer at "Apply this change? [y/N]"
    const written = files.applyEdit(proposal.path, proposal.newContent, { confirmed: answer === 'y', baseHash: proposal.baseHash });
    assert.equal(written.ok, true, written.error);
    assert.equal(written.absolutePath, path.join(fs.realpathSync(dir), 'src', 'cart.js'));
    const r = runProjectTests(dir);
    assert.equal(r.status, 0, `tests still failing:\n${r.stdout}`);
  });

  await step('review: gitDiff sees the change; findings are ranked; Not checked line present', async () => {
    const input = gitDiff('uncommitted', { cwd: dir });
    assert.deepEqual(input.files, ['src/cart.js']);
    assert.match(input.text, /\+  for \(let i = 0; i < items\.length; i\+\+\)/);
    const result = await review(input, {
      ask: async ({ user }) => {
        assert.match(user, /\+ {3}5\| {3}for \(let i = 0; i < items\.length; i\+\+\)/, 'line-numbered diff sent to the model');
        return JSON.stringify({
          findings: [
            { file: 'src/cart.js', line: 3, severity: 'style', what: 'no JSDoc' },
            { file: 'src/cart.js', line: 3, severity: 'bug', what: 'items is not validated', why: 'cartTotal(null) throws', fix: 'check Array.isArray(items)', ifIgnored: 'crash on bad input' },
          ],
        });
      },
    });
    assert.deepEqual(result.findings.map((f) => f.severity), ['bug', 'style']);
    assert.match(formatReport(result), /Not checked: /);
  });

  await step('debt: the shortcut comment is harvested with file:line', () => {
    assert.deepEqual(harvestDebt({ cwd: dir }), [{ path: 'src/cart.js', line: 2, note: 'prices are trusted to be numbers' }]);
  });

  await step('CLI: ls / find / read / debt / version work in the project', () => {
    const ls = runCli(dir, ['ls', '*.js']);
    assert.equal(ls.status, 0, ls.stderr);
    assert.deepEqual(ls.stdout.trim().split(/\r?\n/), ['src/cart.js', 'test/cart.test.js']);
    assert.match(runCli(dir, ['find', 'cartTotal']).stdout, /src\/cart\.js:3: export function cartTotal\(items\) \{/);
    assert.match(runCli(dir, ['read', 'src/cart.js']).stdout, /i < items\.length; i\+\+/);
    assert.match(runCli(dir, ['debt']).stdout, /1 shortcut to pay back[\s\S]*src\/cart\.js:2\s+prices are trusted/);
    assert.match(runCli(dir, ['version']).stdout, /^E\.L\.L\.I\.O\.T \d+\.\d+\.\d+/);
  });

  await step('CLI: errors are one line, no stack traces; no-TTY `elliot` prints help', () => {
    for (const args of [['read', '../x'], ['frobnicate'], ['--bogus'], ['resume', 'abc'], ['edit'], ['debt', 'a.*b']]) {
      const r = runCli(dir, args);
      assert.equal(r.status, 2, `${args.join(' ')} → exit ${r.status}`);
      assert.equal(r.stderr.trim().split(/\r?\n/).length, 1, `${args.join(' ')} printed:\n${r.stderr}`);
      assert.match(r.stderr, /^elliot: /);
      assert.doesNotMatch(r.stderr, /\n\s+at /);
    }
    const help = runCli(dir, []);
    assert.equal(help.status, 0);
    for (const group of ['Chat', 'Code', 'Review', 'Memory', 'System']) assert.match(help.stdout, new RegExp(`^${group}(\\s|$)`, 'm'));
  });

  await step('CLI: edit without a terminal never writes', () => {
    // Reset the fix, then ask the CLI to edit with no TTY and no --yes: it must not apply.
    fs.writeFileSync(path.join(dir, 'src', 'cart.js'), SAMPLE['src/cart.js']);
    const before = fs.readFileSync(path.join(dir, 'src', 'cart.js'), 'utf8');
    // OLLAMA_URL points nowhere, so this also checks the "Ollama missing" one-line error.
    const r = spawnSync(process.execPath, [CLI, 'edit', 'fix the bug'], {
      cwd: dir,
      encoding: 'utf8',
      input: 'y\n', // piped "y" must NOT count as confirmation
      env: { ...process.env, NO_COLOR: '1', OLLAMA_URL: 'http://127.0.0.1:59999' },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /elliot: Ollama is not running/);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'cart.js'), 'utf8'), before);
  });
} finally {
  memory.close();
  // Reset the sample to its buggy state for a manual follow-up run.
  fs.writeFileSync(path.join(dir, 'src', 'cart.js'), SAMPLE['src/cart.js']);
  fs.rmSync(path.join(dir, '.e2e-memory'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  if (keep) console.log(`\nKept the (buggy) project for a manual run: ${dir}`);
  else fs.rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
const seconds = (results.reduce((n, r) => n + r.ms, 0) / 1000).toFixed(1);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length} steps passed in ${seconds}s`);
process.exitCode = failed.length ? 1 : 0;
