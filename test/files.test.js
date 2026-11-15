import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as filesModule from '../app/core/tools/files.js';
import { MAX_FILE_BYTES, createFileTools, globToRegExp } from '../app/core/tools/files.js';

/** A temp project: { root, tools, write(rel, content) }. Removed after the test. */
function tempProject(t, files = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elliot-files-'));
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  const write = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, write, tools: createFileTools(root) };
}

// ---- Path safety ------------------------------------------------------------------

test('path escapes are rejected', (t) => {
  const { base, tools } = tempProject(t, { 'a.js': 'x' });
  fs.writeFileSync(path.join(base, 'secret.txt'), 'outside');
  const attempts = [
    '../secret.txt',
    '..\\secret.txt',
    'src/../../secret.txt',
    path.join(base, 'secret.txt'), // absolute, outside
    process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd',
  ];
  for (const attempt of attempts) {
    for (const result of [tools.readFile(attempt), tools.proposeEdit(attempt, 'x'), tools.applyEdit(attempt, 'x', { confirmed: true })]) {
      assert.equal(result.ok, false, attempt);
      assert.equal(result.code, 'OUTSIDE_PROJECT', attempt);
    }
  }
  assert.equal(fs.readFileSync(path.join(base, 'secret.txt'), 'utf8'), 'outside', 'outside file untouched');
});

test('an absolute path inside the project is allowed', (t) => {
  const { root, tools } = tempProject(t, { 'a.js': 'hello' });
  assert.equal(tools.readFile(path.join(root, 'a.js')).content, 'hello');
});

test('symlinks / junctions pointing outside the project are rejected', (t) => {
  const { base, root, tools } = tempProject(t);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'x.txt'), 'outside');
  try {
    // "junction" needs no admin rights on Windows; ignored elsewhere.
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  } catch (err) {
    t.skip(`cannot create a link here: ${err.code}`);
    return;
  }
  assert.equal(tools.readFile('link/x.txt').code, 'OUTSIDE_PROJECT');
  assert.equal(tools.applyEdit('link/new.txt', 'x', { confirmed: true }).code, 'OUTSIDE_PROJECT');
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  assert.ok(!tools.listFiles().files.some((f) => f.startsWith('link')), 'links are not followed when listing');
});

test('.git, node_modules and secret files are off limits', (t) => {
  const { tools } = tempProject(t, {
    '.git/config': '[core]',
    'node_modules/x/index.js': 'x',
    '.env': 'API_KEY=1',
    '.env.local': 'API_KEY=2',
    '.env.example': 'API_KEY=',
    'certs/server.pem': 'key',
  });
  assert.equal(tools.readFile('.git/config').code, 'FORBIDDEN');
  assert.equal(tools.applyEdit('.git/hooks/pre-commit', 'evil', { confirmed: true }).code, 'FORBIDDEN');
  assert.equal(tools.readFile('node_modules/x/index.js').code, 'FORBIDDEN');
  assert.equal(tools.readFile('.env').code, 'FORBIDDEN');
  assert.equal(tools.readFile('.env.local').code, 'FORBIDDEN');
  assert.equal(tools.readFile('certs/server.pem').code, 'FORBIDDEN');
  assert.equal(tools.readFile('.env.example').ok, true);
  assert.deepEqual(tools.listFiles().files, ['.env.example']);
});

// ---- Reading -----------------------------------------------------------------------

test('binary and oversize files are refused', (t) => {
  const { root, tools } = tempProject(t, { 'ok.txt': 'fine' });
  fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  fs.writeFileSync(path.join(root, 'big.txt'), 'a'.repeat(MAX_FILE_BYTES + 1));
  assert.equal(tools.readFile('image.png').code, 'BINARY');
  assert.equal(tools.readFile('big.txt').code, 'TOO_LARGE');
  assert.equal(tools.proposeEdit('big.txt', 'small').code, 'TOO_LARGE');
  assert.equal(tools.proposeEdit('ok.txt', 'x'.repeat(MAX_FILE_BYTES + 1)).code, 'TOO_LARGE');
  assert.equal(tools.readFile('missing.txt').code, 'NOT_FOUND');
  assert.equal(tools.readFile('.').code, 'NOT_A_FILE');
  assert.equal(tools.readFile('').code, 'BAD_PATH');
});

// ---- Listing and search --------------------------------------------------------------

test('listFiles respects root and nested .gitignore files, including negation', (t) => {
  const { tools } = tempProject(t, {
    '.gitignore': '*.log\n!keep.log\ndist/\n',
    'src/app.js': '',
    'src/.gitignore': 'generated.js\n',
    'src/generated.js': '',
    'src/lib/util.js': '',
    'debug.log': '',
    'keep.log': '',
    'dist/bundle.js': '',
    'README.md': '',
  });
  assert.deepEqual(tools.listFiles().files, ['.gitignore', 'keep.log', 'README.md', 'src/.gitignore', 'src/app.js', 'src/lib/util.js']);
});

test('listFiles filters by glob', (t) => {
  const { tools } = tempProject(t, { 'a.js': '', 'src/b.js': '', 'src/c.ts': '', 'src/deep/d.js': '', 'e.md': '' });
  assert.deepEqual(tools.listFiles('*.js').files, ['a.js', 'src/b.js', 'src/deep/d.js']);
  assert.deepEqual(tools.listFiles('src/**/*.{js,ts}').files, ['src/b.js', 'src/c.ts', 'src/deep/d.js']);
  assert.deepEqual(tools.listFiles('src/*.js').files, ['src/b.js']);
  assert.ok(globToRegExp('**/*.js').test('x.js'));
});

test('searchFiles returns file:line matches with smart case, skipping ignored files', (t) => {
  const { tools } = tempProject(t, {
    '.gitignore': 'ignored.js\n',
    'a.js': 'const user = getUser();\n// TODO: validate user\n',
    'b.js': 'function getUser() {}\n',
    'ignored.js': 'getUser here too\n',
  });
  const { matches } = tools.searchFiles('getuser');
  assert.deepEqual(
    matches.map((m) => `${m.path}:${m.line}: ${m.text}`),
    ['a.js:1: const user = getUser();', 'b.js:1: function getUser() {}'],
  );
  assert.equal(tools.searchFiles('GetUser').matches.length, 0, 'uppercase query is case-sensitive');
  assert.equal(tools.searchFiles('  ').code, 'BAD_QUERY');
});

// ---- Diffs ---------------------------------------------------------------------------

test('proposeEdit returns a correct unified diff and never writes', (t) => {
  const { root, tools } = tempProject(t, { 'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n' });
  const proposal = tools.proposeEdit(
    'src/math.js',
    "export function add(a, b) {\n  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('numbers only');\n  return a + b;\n}\n",
  );
  assert.equal(proposal.ok, true);
  assert.equal(
    proposal.diff,
    [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -1,3 +1,4 @@',
      ' export function add(a, b) {',
      "+  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('numbers only');",
      '   return a + b;',
      ' }',
      '',
    ].join('\n'),
  );
  assert.equal(proposal.additions, 1);
  assert.equal(proposal.deletions, 0);
  assert.equal(proposal.changed, true);
  assert.equal(proposal.absolutePath, path.join(fs.realpathSync(root), 'src', 'math.js'));
  assert.equal(fs.readFileSync(path.join(root, 'src/math.js'), 'utf8'), 'export function add(a, b) {\n  return a + b;\n}\n', 'unchanged on disk');
});

test('proposeEdit for a new file diffs against /dev/null and creates nothing', (t) => {
  const { root, tools } = tempProject(t);
  const proposal = tools.proposeEdit('src/new.js', 'export const x = 1;\n');
  assert.equal(proposal.isNew, true);
  assert.equal(proposal.diff, '--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1,1 @@\n+export const x = 1;\n');
  assert.equal(fs.existsSync(path.join(root, 'src')), false);
});

test('proposeEdit keeps CRLF line endings of Windows files', (t) => {
  const { tools } = tempProject(t, { 'win.js': 'a\r\nb\r\n' });
  const proposal = tools.proposeEdit('win.js', 'a\nB\n');
  assert.equal(proposal.newContent, 'a\r\nB\r\n');
  assert.equal(proposal.additions, 1);
  assert.equal(proposal.deletions, 1);
});

// ---- Writing -------------------------------------------------------------------------

test('applyEdit refuses without explicit confirmation', (t) => {
  const { root, tools } = tempProject(t, { 'a.js': 'old\n' });
  for (const opts of [undefined, {}, { confirmed: false }, { confirmed: 'yes' }, { confirmed: 1 }]) {
    const result = tools.applyEdit('a.js', 'new\n', opts);
    assert.equal(result.code, 'NOT_CONFIRMED', JSON.stringify(opts));
  }
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'old\n');
});

test('propose → simulated confirm → applyEdit writes; decline leaves the file alone', async (t) => {
  const { root, tools } = tempProject(t, { 'a.js': 'old\n' });
  // The same flow the CLI/TUI use, with the y/N answer simulated.
  const flow = async (answer) => {
    const proposal = tools.proposeEdit('a.js', 'new\n');
    const confirmed = await Promise.resolve(answer === 'y');
    if (!confirmed) return null;
    return tools.applyEdit(proposal.path, proposal.newContent, { confirmed, baseHash: proposal.baseHash });
  };
  assert.equal(await flow('n'), null);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'old\n');
  const written = await flow('y');
  assert.equal(written.ok, true);
  assert.equal(written.created, false);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'new\n');
  assert.deepEqual(fs.readdirSync(root), ['a.js'], 'no temp files left behind');
});

test('applyEdit refuses if the file changed after the diff was shown', (t) => {
  const { root, write, tools } = tempProject(t, { 'a.js': 'v1\n' });
  const proposal = tools.proposeEdit('a.js', 'v2\n');
  write('a.js', 'edited in VS Code meanwhile\n');
  const result = tools.applyEdit(proposal.path, proposal.newContent, { confirmed: true, baseHash: proposal.baseHash });
  assert.equal(result.code, 'CHANGED');
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'edited in VS Code meanwhile\n');
});

test('applyEdit creates parent folders for new files', (t) => {
  const { root, tools } = tempProject(t);
  const proposal = tools.proposeEdit('src/deep/new.js', 'x\n');
  const result = tools.applyEdit(proposal.path, proposal.newContent, { confirmed: true, baseHash: proposal.baseHash });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(fs.readFileSync(path.join(root, 'src/deep/new.js'), 'utf8'), 'x\n');
});

test('there is no delete operation', (t) => {
  const { tools } = tempProject(t);
  const names = [...Object.keys(tools), ...Object.keys(filesModule)];
  assert.ok(!names.some((n) => /delete|remove|unlink|rm/i.test(n)), names.join(', '));
});
