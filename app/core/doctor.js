// `elliot doctor`: a one-shot health report for a new machine or the pendrive.
// Every probe is injectable so the report can be tested without Ollama/git.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from './config.js';
import { isModelInstalled, listModels } from './llm.js';
import { projectFor } from './memory.js';

export const MIN_NODE_MAJOR = 22;

/** First match of `where`/`which`, or null. */
export function which(command) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [command], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  return r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null : null;
}

/** Top folder of the git repo containing cwd, or null. */
export function gitTopLevel(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
}

/**
 * Can Elliot write its memory DB? Takes (and immediately releases) a write
 * lock, so a DB held by another process shows up as "locked".
 * @returns {{ exists: boolean, writable: boolean, error: string|null }}
 */
export function checkDbWritable(dbFile) {
  const exists = fs.existsSync(dbFile);
  try {
    if (!exists) {
      // Not created yet: check the folder instead (it will be created on first use).
      const dir = path.dirname(dbFile);
      fs.accessSync(fs.existsSync(dir) ? dir : path.dirname(dir), fs.constants.W_OK);
      return { exists, writable: true, error: null };
    }
    const db = new Database(dbFile, { timeout: 500 });
    try {
      db.exec('BEGIN IMMEDIATE; ROLLBACK;');
    } finally {
      db.close();
    }
    return { exists, writable: true, error: null };
  } catch (err) {
    return { exists, writable: false, error: err.code ?? err.message };
  }
}

const samePath = (a, b) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/**
 * Gathers the report. All inputs have real defaults; tests pass fakes.
 */
export async function collectDoctorReport({
  cwd = process.cwd(),
  nodeVersion = process.versions.node,
  cfg = config,
  env = process.env,
  homedir = os.homedir(),
  probes = {},
} = {}) {
  const p = { which, gitTopLevel, checkDbWritable, listModels, ...probes };

  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  let installed = null;
  let ollamaError = null;
  try {
    installed = await p.listModels();
  } catch (err) {
    ollamaError = err.message;
  }

  const gitRoot = p.gitTopLevel(cwd);
  return {
    node: { version: nodeVersion, ok: major >= MIN_NODE_MAJOR },
    elliot: { version: cfg.version, root: cfg.paths.root, layout: cfg.paths.layout, onPath: p.which('elliot') },
    ollama: {
      url: cfg.ollamaUrl,
      binary: p.which('ollama'),
      online: installed !== null,
      error: ollamaError,
      modelsDir: env.OLLAMA_MODELS || null,
    },
    models:
      installed === null
        ? null
        : Object.entries(cfg.models).map(([role, m]) => ({ role, name: m.name, load: m.load, installed: isModelInstalled(installed, m.name) })),
    memory: { dbFile: cfg.paths.dbFile, ...p.checkDbWritable(cfg.paths.dbFile) },
    project: {
      cwd,
      key: projectFor(cwd),
      gitRoot,
      insideHomeRepo: gitRoot !== null && samePath(gitRoot, homedir) && !samePath(cwd, homedir),
    },
    settings: { aiMode: cfg.aiMode, voice: cfg.voice, autoReason: cfg.autoReason },
  };
}

/**
 * Turns the report into lines with ✅ / ⚠️ / ❌.
 * @returns {{ text: string, problems: number, warnings: number }}
 */
export function formatDoctor(report) {
  const lines = [];
  let problems = 0;
  let warnings = 0;
  const ok = (text) => lines.push(`✅ ${text}`);
  const warn = (text) => {
    warnings++;
    lines.push(`⚠️  ${text}`);
  };
  const bad = (text) => {
    problems++;
    lines.push(`❌ ${text}`);
  };
  const note = (text) => lines.push(`   ${text}`);
  const section = (title) => lines.push('', title);

  lines.push(`E.L.L.I.O.T doctor (v${report.elliot.version})`);

  section('System');
  if (report.node.ok) ok(`Node.js ${report.node.version}`);
  else bad(`Node.js ${report.node.version} — Elliot needs ${MIN_NODE_MAJOR} or newer (https://nodejs.org)`);
  ok(`Elliot folder: ${report.elliot.root} (${report.elliot.layout} layout)`);
  if (report.elliot.onPath) ok(`elliot command: ${report.elliot.onPath}`);
  else warn('elliot is not on PATH — run `npm link` in the Elliot folder, or start with start-elliot.bat');

  section('Ollama');
  if (report.ollama.binary) ok(`installed: ${report.ollama.binary}`);
  else warn('ollama not found on PATH (fine if a portable copy is started by start-elliot.bat)');
  if (report.ollama.online) ok(`running at ${report.ollama.url}`);
  else bad(`not reachable at ${report.ollama.url}: ${report.ollama.error ?? 'unknown error'}`);
  note(`models folder: ${report.ollama.modelsDir ?? "Ollama's default (OLLAMA_MODELS not set)"}`);

  section('Models');
  if (report.models === null) {
    note('(unknown while Ollama is offline)');
  } else {
    for (const m of report.models) {
      const label = `${m.role.padEnd(6)} ${m.name} (${m.load})`;
      if (m.installed) ok(label);
      else if (m.load === 'always') bad(`${label} — ollama pull ${m.name}`);
      else warn(`${label} — optional: ollama pull ${m.name}`);
    }
  }

  section('Memory');
  const db = report.memory;
  if (db.writable) ok(`${db.dbFile} ${db.exists ? '(writable)' : '(will be created on first use)'}`);
  else bad(`${db.dbFile} is not writable (${db.error}) — Elliot will use temporary memory`);

  section('Current project');
  ok(`${report.project.cwd}`);
  note(`memory key: ${report.project.key}`);
  if (report.project.gitRoot) {
    if (report.project.insideHomeRepo) {
      warn(`inside the git repo at ${report.project.gitRoot} (your home folder) — reviews are limited to this folder`);
    } else {
      ok(`git repo: ${report.project.gitRoot}`);
    }
  } else {
    note('not a git repository (elliot review needs one)');
  }

  section('Settings');
  note(`mode: ${report.settings.aiMode} · voice: ${report.settings.voice} · AUTO_REASON: ${report.settings.autoReason ? 'on' : 'off'}`);

  lines.push('', problems ? `${problems} problem(s), ${warnings} warning(s).` : warnings ? `All good, ${warnings} warning(s).` : 'All good.');
  return { text: lines.join('\n'), problems, warnings };
}
