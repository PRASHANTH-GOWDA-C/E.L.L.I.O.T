// Review core. Uses throwaway git repos in temp folders (never the Elliot repo) and a fake model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReviewError,
  annotateDiff,
  audit,
  chunkDiff,
  entryPoints,
  formatDebt,
  formatReport,
  gitDiff,
  harvestDebt,
  parseFindings,
  rankAuditFiles,
  review,
  sortFindings,
  summarize,
} from '../app/core/review.js';
import { createFileTools } from '../app/core/tools/files.js';

function tempDir(t, prefix = 'elliot-review-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A temp git repo with one commit on "main". Returns { dir, git, write }. */
function tempRepo(t, files = { 'app.js': 'export const add = (a, b) => a + b;\n' }) {
  const dir = tempDir(t);
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git, write };
}

const expectReviewError = (fn, code) =>
  assert.throws(fn, (err) => err instanceof ReviewError && err.code === code, `expected ReviewError ${code}`);

// ---- gitDiff -------------------------------------------------------------------------

test('gitDiff: a folder that is not a git repo → NOT_A_REPO', (t) => {
  const dir = tempDir(t);
  // Stop git from finding a repo in a parent folder (e.g. a home folder that is a repo).
  const before = process.env.GIT_CEILING_DIRECTORIES;
  const parent = path.dirname(dir);
  process.env.GIT_CEILING_DIRECTORIES = [parent, fs.realpathSync.native(parent)].join(path.delimiter);
  t.after(() => {
    if (before === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = before;
  });
  expectReviewError(() => gitDiff('uncommitted', { cwd: dir }), 'NOT_A_REPO');
});

test('gitDiff: a project inside a bigger repo only reviews its own folder', (t) => {
  const { dir, write } = tempRepo(t, { 'outer.js': 'outer\n', 'project/app.js': 'a\n' });
  write('outer.js', 'OUTER CHANGED\n');
  write('outer-new.js', 'untracked outside the project\n');
  write('project/app.js', 'A\n');
  write('project/new.js', 'new\n');
  const result = gitDiff('uncommitted', { cwd: path.join(dir, 'project') });
  assert.deepEqual(result.files.sort(), ['app.js', 'new.js'], 'paths relative to the project, nothing from outside');
  assert.doesNotMatch(result.text, /outer/i);
});

test('gitDiff: clean repo → NO_CHANGES for uncommitted, staged and branch', (t) => {
  const { dir } = tempRepo(t);
  expectReviewError(() => gitDiff('uncommitted', { cwd: dir }), 'NO_CHANGES');
  expectReviewError(() => gitDiff('staged', { cwd: dir }), 'NO_CHANGES');
  expectReviewError(() => gitDiff('branch', { cwd: dir }), 'NO_CHANGES'); // on main itself
});

test('gitDiff: uncommitted includes modified and new untracked files, not ignored ones', (t) => {
  const { dir, write } = tempRepo(t, { 'app.js': 'export const add = (a, b) => a + b;\n', '.gitignore': 'secret.log\n' });
  write('app.js', 'export const add = (a, b) => a - b;\n');
  write('src/new.js', 'export const x = 1;\n');
  write('secret.log', 'ignored\n');
  const result = gitDiff(undefined, { cwd: dir }); // default target
  assert.equal(result.target, 'uncommitted');
  assert.equal(result.kind, 'diff');
  assert.match(result.text, /-export const add = \(a, b\) => a \+ b;/);
  assert.match(result.text, /\+export const add = \(a, b\) => a - b;/);
  assert.match(result.text, /\+\+\+ b\/src\/new\.js/);
  assert.doesNotMatch(result.text, /secret\.log/);
  assert.deepEqual(result.files.sort(), ['app.js', 'src/new.js']);
});

test('gitDiff: staged only shows staged changes', (t) => {
  const { dir, git, write } = tempRepo(t, { 'a.js': 'a\n', 'b.js': 'b\n' });
  write('a.js', 'A\n');
  write('b.js', 'B\n');
  git('add', 'a.js');
  const result = gitDiff('staged', { cwd: dir });
  assert.deepEqual(result.files, ['a.js']);
  assert.match(result.description, /staged/);
});

test('gitDiff: branch compares with the default branch', (t) => {
  const { dir, git, write } = tempRepo(t);
  git('checkout', '-q', '-b', 'feature');
  write('feature.js', 'export const f = () => 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  const result = gitDiff('branch', { cwd: dir });
  assert.deepEqual(result.files, ['feature.js']);
  assert.match(result.description, /compared with main/);
});

test('gitDiff: a file path gives its diff, or the whole file when unchanged', (t) => {
  const { dir, write } = tempRepo(t, { 'a.js': 'one\n', 'b.js': 'two\n' });
  write('a.js', 'ONE\n');
  const changed = gitDiff('a.js', { cwd: dir });
  assert.equal(changed.kind, 'diff');
  assert.match(changed.text, /\+ONE/);
  const whole = gitDiff('b.js', { cwd: dir });
  assert.equal(whole.kind, 'code');
  assert.equal(whole.text, 'two\n');
});

test('gitDiff: unknown targets and paths outside the project → BAD_TARGET', (t) => {
  const { dir } = tempRepo(t);
  expectReviewError(() => gitDiff('nonsense', { cwd: dir }), 'BAD_TARGET');
  expectReviewError(() => gitDiff('../outside.js', { cwd: dir }), 'BAD_TARGET');
});

// ---- Preparing input -------------------------------------------------------------------

test('annotateDiff numbers lines with their new-file line numbers', () => {
  const diff = '--- a/x.js\n+++ b/x.js\n@@ -10,3 +10,3 @@\n keep\n-old\n+new\n keep2';
  assert.equal(annotateDiff(diff), '--- a/x.js\n+++ b/x.js\n@@ -10,3 +10,3 @@\n   10| keep\n-    | old\n+  11| new\n   12| keep2');
});

test('chunkDiff splits by file and caps the number of chunks', () => {
  const section = (n) => `diff --git a/f${n}.js b/f${n}.js\n--- a/f${n}.js\n+++ b/f${n}.js\n@@ -1 +1 @@\n-${'x'.repeat(3000)}\n+y\n`;
  const diff = Array.from({ length: 10 }, (_, i) => section(i)).join('');
  const { chunks, skippedFiles } = chunkDiff(diff, { chunkChars: 7000, maxChunks: 3 });
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.length <= 7000 + 200));
  assert.equal(skippedFiles, 4); // 2 files per chunk: 6 reviewed, 4 skipped
});

// ---- Parsing and sorting ----------------------------------------------------------------

test('parseFindings tolerates imperfect JSON and normalises fields', () => {
  const messy = `\`\`\`json
{'findings': [
  {'file': 'a.js', 'line': '12', 'severity': 'Performance', 'issue': 'loops twice', 'impact': 'slow', 'suggestion': 'loop once', 'if_ignored': 'lag',},
  {"file": "b.js", "severity": "nonsense", "what": "odd name"},
  {"severity": "bug"}
], 'notChecked': 'not run',}
\`\`\``;
  const { findings, notChecked, parseError } = parseFindings(messy);
  assert.equal(parseError, false);
  assert.equal(notChecked, 'not run');
  assert.deepEqual(findings[0], { file: 'a.js', line: 12, severity: 'perf', what: 'loops twice', why: 'slow', fix: 'loop once', ifIgnored: 'lag' });
  assert.equal(findings[1].severity, 'style'); // unknown severity → style
  assert.equal(findings.length, 2); // the entry without "what" is dropped
});

test('parseFindings accepts a bare array and reports hopeless output', () => {
  assert.equal(parseFindings('[{"what": "x", "severity": "security"}]').findings[0].severity, 'security');
  assert.deepEqual(parseFindings('The code looks fine to me!'), { findings: [], notChecked: null, parseError: true });
});

test('findings are sorted bug > security > perf > test > style, then file and line', () => {
  const f = (severity, file, line) => ({ severity, file, line, what: `${severity} ${file}:${line}` });
  const sorted = sortFindings([f('style', 'a.js', 1), f('perf', 'a.js', 1), f('bug', 'b.js', 9), f('test', 'a.js', 1), f('security', 'a.js', 1), f('bug', 'b.js', 2), f('bug', 'a.js', 5)]);
  assert.deepEqual(
    sorted.map((x) => x.what),
    ['bug a.js:5', 'bug b.js:2', 'bug b.js:9', 'security a.js:1', 'perf a.js:1', 'test a.js:1', 'style a.js:1'],
  );
});

// ---- review() with a fake model --------------------------------------------------------

test('review: ranks findings, dedupes, and always ends with "Not checked"', async () => {
  const prompts = [];
  const ask = async ({ system, user }) => {
    prompts.push({ system, user });
    return JSON.stringify({
      findings: [
        { file: 'a.js', line: 3, severity: 'style', what: 'name', why: 'w', fix: 'f', ifIgnored: 'i' },
        { file: 'a.js', line: 2, severity: 'bug', what: 'subtracts', why: 'wrong sum', fix: 'use +', ifIgnored: 'wrong totals' },
        { file: 'a.js', line: 2, severity: 'bug', what: 'subtracts', why: 'dup', fix: 'dup', ifIgnored: 'dup' },
      ],
    });
  };
  const diff = '--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n x\n-a + b\n+a - b';
  const result = await review(diff, { ask });
  assert.deepEqual(result.findings.map((f) => f.severity), ['bug', 'style']);
  assert.match(result.notChecked, /not executed/); // default when the model gives none
  assert.match(prompts[0].system, /Ponytail/);
  assert.match(prompts[0].system, /never optional/);
  assert.match(prompts[0].system, /ifIgnored/);
  assert.match(prompts[0].user, /\+   2\| a - b/, 'diff is line-numbered for the model');
  const text = formatReport(result);
  assert.match(text, /^1 bug, 1 style/m);
  assert.match(text, /BUG \(1\)\n  ● a\.js:2  subtracts\n      why:        wrong sum\n      fix:        use \+\n      if ignored: wrong totals/);
  assert.match(text.trim().split('\n').at(-1), /^Not checked: /);
});

test('review: unparseable model output is kept as raw text, not a crash', async () => {
  const result = await review('--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b', { ask: async () => 'Looks good, ship it.' });
  assert.equal(result.findings.length, 0);
  assert.equal(result.parseErrors, 1);
  assert.match(formatReport(result), /could not parse[\s\S]*Looks good, ship it\./);
});

test('review: whole-file input is numbered and labelled', async () => {
  let user = '';
  await review({ kind: 'code', text: 'a\nb\n', files: ['x.js'] }, { ask: async (o) => ((user = o.user), '{"findings":[]}') });
  assert.match(user, /^Review this file:\n\nFile: x\.js\n   1\| a\n   2\| b/);
});

// ---- Audit ------------------------------------------------------------------------------

test('audit: respects the file cap and reviews entry points first', async (t) => {
  const dir = tempDir(t);
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  write('package.json', JSON.stringify({ main: 'src/index.js', bin: { tool: 'bin/cli.js' }, scripts: { start: 'node server/app.js' } }));
  write('src/index.js', 'x\n');
  write('bin/cli.js', 'x\n');
  write('server/app.js', 'x\n');
  write('src/big.js', 'y\n'.repeat(500));
  write('src/small.js', 'z\n');
  write('test/index.test.js', 'w\n'.repeat(900)); // big but low priority
  write('README.md', 'not source');

  assert.deepEqual(entryPoints(dir).sort(), ['bin/cli.js', 'server/app.js', 'src/index.js']);
  const ranked = rankAuditFiles(dir, createFileTools(dir));
  assert.deepEqual(ranked.slice(3), ['src/big.js', 'src/small.js', 'test/index.test.js']);

  const seen = [];
  const ask = async ({ user }) => {
    seen.push(...[...user.matchAll(/^File: (.+)$/gm)].map((m) => m[1]));
    return '{"findings":[{"file":"src/index.js","line":1,"severity":"perf","what":"slow"},{"file":"bin/cli.js","line":1,"severity":"bug","what":"crash"}]}';
  };
  const progress = [];
  const result = await audit({ cwd: dir, maxFiles: 4, filesPerBatch: 2, ask, onProgress: (e) => progress.push(e) });
  assert.equal(seen.length, 4, 'never more files than the cap');
  assert.deepEqual(seen.slice(0, 3).sort(), ['bin/cli.js', 'server/app.js', 'src/index.js']);
  assert.equal(seen[3], 'src/big.js');
  assert.equal(progress.filter((e) => e.type === 'batch').length, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.totalSource, 6);
  assert.match(result.notChecked, /2 of 6 source files were not reviewed \(audit limit 4\)/);
  assert.equal(result.findings[0].severity, 'bug', 'worst first');
  assert.equal(summarize(result.findings), '1 bug, 1 perf');
});

test('summarize pluralises bugs only', () => {
  const f = (severity) => ({ severity, what: 'x' });
  assert.equal(summarize([f('bug'), f('bug'), f('bug'), f('perf'), f('perf'), ...Array(5).fill(f('style'))]), '3 bugs, 2 perf, 5 style');
  assert.equal(summarize([]), 'No problems found');
});

// ---- Debt -------------------------------------------------------------------------------

test('harvestDebt finds shortcut comments with file:line in any comment style', (t) => {
  const dir = tempDir(t);
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  write('.gitignore', 'ignored.js\n');
  write('src/a.js', 'const x = 1; // shortcut: hard-coded limit\nconst s = "shortcut: not a comment";\n/* Shortcut: use a queue */\n');
  write('db/schema.sql', 'SELECT 1; -- shortcut: no index yet\n');
  write('script.py', 'x = 1\n# shortcut:   retry once only\n');
  write('ignored.js', '// shortcut: should not appear\n');
  write('notes.js', '// hack: custom word\n');

  assert.deepEqual(
    harvestDebt({ cwd: dir }).map((i) => `${i.path}:${i.line} ${i.note}`),
    ['db/schema.sql:1 no index yet', 'script.py:2 retry once only', 'src/a.js:1 hard-coded limit', 'src/a.js:3 use a queue'],
  );
  assert.deepEqual(harvestDebt({ cwd: dir, word: 'hack' }).map((i) => i.note), ['custom word']);
  assert.throws(() => harvestDebt({ cwd: dir, word: 'a.*b' }), /debt word/);

  // Markers inside string literals are not debt; apostrophes in the note itself are fine.
  write('strings.js', [
    "const fixture = '// shortcut: inside a string';",
    'const tpl = `# shortcut: in a template`;',
    "const ok = 1; // shortcut: don't retry, it's 'fine'",
  ].join('\n'));
  assert.deepEqual(
    harvestDebt({ cwd: dir }).filter((i) => i.path === 'strings.js').map((i) => `${i.line} ${i.note}`),
    ["3 don't retry, it's 'fine'"],
  );
  fs.rmSync(path.join(dir, 'strings.js'));
  assert.match(formatDebt(harvestDebt({ cwd: dir })), /^4 shortcuts to pay back\n\n  db\/schema\.sql:1  no index yet/);
  assert.equal(formatDebt([], 'hack'), 'No "hack:" comments found.');
});
