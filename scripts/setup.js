// `npm run setup`: first-run setup. Safe to run again — every step checks first
// and only acts when something is missing.
//
// Deliberately imports nothing from node_modules until dependencies are known
// to be installed (step 2), so it works on a fresh checkout.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE_MAJOR = 22;
const isWindows = process.platform === 'win32';

const step = (n, title) => console.log(`\n[${n}/5] ${title}`);
const ok = (text) => console.log(`  ✅ ${text}`);
const warn = (text) => console.log(`  ⚠️  ${text}`);
const bad = (text) => console.log(`  ❌ ${text}`);
const info = (text) => console.log(`     ${text}`);

/**
 * Runs `npm <subcommand>`. npm is a .cmd file on Windows, which needs a shell;
 * the command is a fixed string (never user input), so passing it whole is safe.
 */
function npm(subcommand) {
  return spawnSync(`npm ${subcommand}`, { cwd: ROOT, stdio: 'inherit', shell: true });
}

function which(command) {
  const r = spawnSync(isWindows ? 'where' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

console.log('E.L.L.I.O.T setup');
let problems = 0;

// 1. Node.js
step(1, 'Node.js');
const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major < MIN_NODE_MAJOR) {
  bad(`Node.js ${process.versions.node} is too old — Elliot needs ${MIN_NODE_MAJOR}+ (https://nodejs.org)`);
  process.exit(1);
}
ok(`Node.js ${process.versions.node}`);

// 2. Dependencies
step(2, 'Dependencies');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// Look at node_modules directly: some packages (ink, htm) don't export package.json.
const missingDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
  (dep) => !fs.existsSync(path.join(ROOT, 'node_modules', dep, 'package.json')),
);
if (missingDeps.length === 0) {
  ok('all dependencies installed');
} else {
  info(`installing: ${missingDeps.join(', ')}`);
  if (npm('install').status !== 0) {
    bad('npm install failed — see the output above');
    process.exit(1);
  }
  ok('dependencies installed');
}

// From here on, Elliot's own modules (which use dependencies) can be loaded.
const { default: config } = await import('../app/core/config.js');
const { isModelInstalled, listModels } = await import('../app/core/llm.js');

// 3. Ollama
step(3, 'Ollama');
const ollamaPath = which('ollama')[0];
if (ollamaPath) ok(`installed: ${ollamaPath}`);
else {
  bad('Ollama is not installed — download it from https://ollama.com/download');
  problems++;
}
let installed = null;
try {
  installed = await listModels();
  ok(`running at ${config.ollamaUrl}`);
} catch (err) {
  bad(err.message);
  if (ollamaPath) info('start it with `ollama serve` (or the Ollama app), then run `npm run setup` again');
  problems++;
}

// 4. Models
step(4, 'Models');
if (installed === null) {
  info('skipped: Ollama is not running');
} else {
  const missing = [];
  for (const [role, m] of Object.entries(config.models)) {
    const label = `${role.padEnd(6)} ${m.name} (${m.load})`;
    if (isModelInstalled(installed, m.name)) ok(label);
    else {
      (m.load === 'always' ? bad : warn)(label);
      missing.push(m);
    }
  }
  if (missing.length) {
    info('');
    info('To download the missing models:');
    for (const m of new Set(missing.map((x) => x.name))) info(`  ollama pull ${m}`);
    if (missing.some((m) => m.load === 'always')) problems++;
  }
}

// 5. The `elliot` command
step(5, 'The elliot command');
const linkedHere = which('elliot').some((p) => {
  // npm's shim lives in the global npm folder; check that it points at this checkout.
  try {
    const target = fs.realpathSync(path.join(path.dirname(p), 'node_modules', 'elliot'));
    return path.resolve(target).toLowerCase() === ROOT.toLowerCase();
  } catch {
    return path.resolve(path.dirname(p)).toLowerCase() === path.join(ROOT, 'bin').toLowerCase();
  }
});
if (linkedHere) {
  ok('`elliot` already points at this folder');
} else {
  info('running npm link …');
  if (npm('link').status === 0) ok('`elliot` is now available in every terminal');
  else {
    warn('npm link failed. Alternatives:');
    info(`  • add ${path.join(ROOT, 'bin')} to your PATH, or`);
    info('  • start Elliot with start-elliot.bat (it adds bin\\ to PATH for that terminal)');
  }
}

// Next steps
console.log(problems ? `\n${problems} thing(s) to fix above, then run \`npm run setup\` again.` : '\nSetup complete.');
console.log(`
Next steps:
  • elliot doctor          check everything in one report
  • elliot                 open the full-screen chat
  • start-elliot.bat       one double-click: starts Ollama, warms up the model, opens a terminal
  • cp .env.example .env   only if you want to change models, voice or AUTO_REASON`);
process.exitCode = problems ? 1 : 0;
