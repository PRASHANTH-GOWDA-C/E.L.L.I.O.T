import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findElliotRoot, resolvePaths } from '../app/core/paths.js';
import config from '../app/core/config.js';
import { collectDoctorReport, formatDoctor } from '../app/core/doctor.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elliot-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const writePkg = (dir, name = 'elliot') => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
};

// ---- paths.js ------------------------------------------------------------------------

test('paths: repo layout resolves from a script location, not the cwd', (t) => {
  const repo = path.join(tempDir(t), 'E.L.L.I.O.T');
  writePkg(repo);
  fs.writeFileSync(path.join(path.dirname(repo), 'unrelated.txt'), '');
  const p = resolvePaths(path.join(repo, 'app', 'core', 'paths.js')); // file need not exist
  assert.equal(p.root, repo);
  assert.equal(p.layout, 'repo');
  assert.equal(p.dbFile, path.join(repo, 'memory', 'elliot.db'));
  assert.equal(p.models, path.join(repo, 'models'));
  assert.equal(p.bin, path.join(repo, 'bin'));
  assert.equal(p.launcher, path.join(repo, 'start-elliot.bat'));
  // Same answer from a script in another subfolder.
  assert.equal(resolvePaths(path.join(repo, 'scripts', 'setup.js')).root, repo);
});

test('paths: pendrive layout (X:/start-elliot.bat + X:/elliot/...)', (t) => {
  const drive = tempDir(t);
  const elliot = path.join(drive, 'elliot');
  writePkg(elliot);
  fs.writeFileSync(path.join(drive, 'start-elliot.bat'), '@echo off');
  const p = resolvePaths(path.join(elliot, 'app', 'cli', 'index.js'));
  assert.equal(p.layout, 'pendrive');
  assert.equal(p.root, elliot);
  assert.equal(p.models, path.join(elliot, 'models'));
  assert.equal(p.memory, path.join(elliot, 'memory'));
  assert.equal(p.runtime, path.join(elliot, 'runtime'));
  assert.equal(p.launcher, path.join(drive, 'start-elliot.bat'));
});

test('paths: a folder named "elliot" without the launcher above it is still repo layout', (t) => {
  const elliot = path.join(tempDir(t), 'elliot');
  writePkg(elliot);
  assert.equal(resolvePaths(path.join(elliot, 'app', 'x.js')).layout, 'repo');
});

test('paths: ignores other package.json files and fails outside Elliot', (t) => {
  const base = tempDir(t);
  const elliot = path.join(base, 'E');
  writePkg(elliot);
  writePkg(path.join(elliot, 'node_modules', 'dep'), 'dep'); // a dependency's package.json
  assert.equal(findElliotRoot(path.join(elliot, 'node_modules', 'dep', 'index.js')), elliot);
  assert.throws(() => findElliotRoot(path.join(base, 'nowhere', 'x.js')), /cannot find Elliot's folder/);
});

test('paths: the real config uses this checkout, wherever the process runs', () => {
  const expectedRoot = path.resolve(import.meta.dirname, '..');
  assert.equal(config.paths.root, expectedRoot);
  assert.equal(config.paths.dbFile, path.join(expectedRoot, 'memory', 'elliot.db'));
});

// ---- doctor -------------------------------------------------------------------------

const fakeCfg = {
  version: '9.9.9',
  ollamaUrl: 'http://127.0.0.1:11434',
  aiMode: 'offline',
  voice: 'plain',
  autoReason: false,
  paths: { root: 'X:\\elliot', layout: 'pendrive', dbFile: 'X:\\elliot\\memory\\elliot.db' },
  models: {
    coder: { name: 'qwen2.5-coder:7b', load: 'always' },
    fast: { name: 'qwen2.5-coder:1.5b', load: 'on-demand' },
  },
};

function probes(overrides = {}) {
  return {
    which: (cmd) => ({ elliot: 'X:\\elliot\\bin\\elliot.cmd', ollama: 'C:\\Ollama\\ollama.exe' })[cmd] ?? null,
    gitTopLevel: () => 'D:\\work\\shop',
    checkDbWritable: () => ({ exists: true, writable: true, error: null }),
    listModels: async () => ['qwen2.5-coder:7b'],
    ...overrides,
  };
}

test('doctor: assembles a healthy report from mocked inputs', async () => {
  const report = await collectDoctorReport({
    cwd: 'D:\\work\\shop',
    nodeVersion: '22.11.0',
    cfg: fakeCfg,
    env: { OLLAMA_MODELS: 'X:\\elliot\\models' },
    homedir: 'C:\\Users\\me',
    probes: probes(),
  });
  assert.deepEqual(report.node, { version: '22.11.0', ok: true });
  assert.deepEqual(report.elliot, { version: '9.9.9', root: 'X:\\elliot', layout: 'pendrive', onPath: 'X:\\elliot\\bin\\elliot.cmd' });
  assert.equal(report.ollama.online, true);
  assert.equal(report.ollama.modelsDir, 'X:\\elliot\\models');
  assert.deepEqual(
    report.models.map((m) => [m.role, m.installed]),
    [
      ['coder', true],
      ['fast', false],
    ],
  );
  assert.equal(report.memory.writable, true);
  assert.equal(report.project.gitRoot, 'D:\\work\\shop');
  assert.equal(report.project.insideHomeRepo, false);

  const { text, problems, warnings } = formatDoctor(report);
  assert.equal(problems, 0);
  assert.equal(warnings, 1); // the optional fast model
  assert.match(text, /✅ Node\.js 22\.11\.0/);
  assert.match(text, /✅ Elliot folder: X:\\elliot \(pendrive layout\)/);
  assert.match(text, /models folder: X:\\elliot\\models/);
  assert.match(text, /⚠️  fast   qwen2\.5-coder:1\.5b \(on-demand\) — optional: ollama pull qwen2\.5-coder:1\.5b/);
  assert.match(text, /✅ git repo: D:\\work\\shop/);
  assert.match(text, /All good, 1 warning\(s\)\.$/);
});

test('doctor: flags old Node, offline Ollama, unwritable memory and missing PATH', async () => {
  const report = await collectDoctorReport({
    cwd: 'C:\\Users\\me\\scratch',
    nodeVersion: '20.11.1',
    cfg: fakeCfg,
    env: {},
    homedir: 'C:\\Users\\me',
    probes: probes({
      which: () => null,
      listModels: async () => {
        throw new Error('Ollama is not running — start it with `ollama serve`');
      },
      checkDbWritable: () => ({ exists: true, writable: false, error: 'SQLITE_BUSY' }),
      gitTopLevel: () => 'C:\\Users\\me', // the home folder is a git repo
    }),
  });
  assert.equal(report.node.ok, false);
  assert.equal(report.models, null);
  assert.equal(report.project.insideHomeRepo, true);

  const { text, problems } = formatDoctor(report);
  assert.equal(problems, 3); // node, ollama, memory
  assert.match(text, /❌ Node\.js 20\.11\.1 — Elliot needs 22 or newer/);
  assert.match(text, /❌ not reachable at http:\/\/127\.0\.0\.1:11434: Ollama is not running/);
  assert.match(text, /\(unknown while Ollama is offline\)/);
  assert.match(text, /❌ X:\\elliot\\memory\\elliot\.db is not writable \(SQLITE_BUSY\)/);
  assert.match(text, /⚠️  elliot is not on PATH/);
  assert.match(text, /⚠️  inside the git repo at C:\\Users\\me \(your home folder\)/);
  assert.match(text, /OLLAMA_MODELS not set/);
  assert.match(text, /3 problem\(s\)/);
});

test('doctor: a missing always-loaded model is a problem, not a warning', async () => {
  const report = await collectDoctorReport({
    cfg: fakeCfg,
    nodeVersion: '24.0.0',
    probes: probes({ listModels: async () => [] }),
  });
  const { text, problems } = formatDoctor(report);
  assert.equal(problems, 1);
  assert.match(text, /❌ coder  qwen2\.5-coder:7b \(always\) — ollama pull qwen2\.5-coder:7b/);
});

test('doctor: checkDbWritable reports a locked database', async (t) => {
  const { checkDbWritable } = await import('../app/core/doctor.js');
  const { default: Database } = await import('better-sqlite3');
  const dir = tempDir(t);
  const file = path.join(dir, 'elliot.db');
  assert.deepEqual(checkDbWritable(file), { exists: false, writable: true, error: null });
  const holder = new Database(file);
  holder.exec('CREATE TABLE x (a); BEGIN EXCLUSIVE;');
  assert.deepEqual(checkDbWritable(file), { exists: true, writable: false, error: 'SQLITE_BUSY' });
  holder.exec('ROLLBACK');
  assert.equal(checkDbWritable(file).writable, true);
  holder.close();
});
