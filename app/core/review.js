// Code review (Ponytail rules): /review, /audit and /debt.
//
// Everything is bounded for a CPU-only laptop: diffs are split into a few
// small chunks, audit looks at a capped number of files, and every model call
// streams (so it has first-token and idle timeouts and can be cancelled).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import config from './config.js';
import { chatStream } from './llm.js';
import { parseLooseJson } from './agent.js';
import { createFileTools } from './tools/files.js';

export const SEVERITIES = ['bug', 'security', 'perf', 'test', 'style'];
const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
const SEVERITY_ALIASES = {
  bug: 'bug', bugs: 'bug', error: 'bug', correctness: 'bug', logic: 'bug', crash: 'bug', critical: 'bug',
  security: 'security', sec: 'security', vulnerability: 'security', injection: 'security',
  perf: 'perf', performance: 'perf', speed: 'perf', load: 'perf', memory: 'perf',
  test: 'test', tests: 'test', testing: 'test', coverage: 'test',
  style: 'style', readability: 'style', naming: 'style', maintainability: 'style', nit: 'style', minor: 'style',
};

const CHUNK_CHARS = 7_000; // diff/code per model call: fits a 4096-token context with the prompt
const MAX_CHUNKS = 4;
const MAX_FINDINGS_PER_CALL = 8;
const DEFAULT_NOT_CHECKED = 'the code was not executed; only the shown changes were reviewed, not the rest of the project.';

const SOURCE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'sql', 'java', 'go', 'rb', 'php', 'c', 'cpp', 'cs', 'rs', 'sh']);
const LOW_PRIORITY = /(^|\/)(test|tests|__tests__|spec|dist|build|vendor|coverage)\/|\.(test|spec)\.[a-z]+$|\.min\.js$/i;

export class ReviewError extends Error {
  /** @param {'NOT_A_REPO'|'NO_CHANGES'|'GIT_MISSING'|'BAD_TARGET'|'GIT_ERROR'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
  }
}

// ---- git -----------------------------------------------------------------------

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 15_000, windowsHide: true });
  if (result.error?.code === 'ENOENT') throw new ReviewError('GIT_MISSING', 'git is not installed or not on PATH');
  if (result.error) throw new ReviewError('GIT_ERROR', `git ${args[0]} failed: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function gitOk(args, cwd) {
  const r = git(args, cwd);
  if (r.status !== 0) throw new ReviewError('GIT_ERROR', `git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

function repoRoot(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  if (r.status !== 0) throw new ReviewError('NOT_A_REPO', `${cwd} is not inside a git repository`);
  return path.resolve(r.stdout.trim());
}

const hasCommits = (cwd) => git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd).status === 0;
// --relative + the "." pathspec scope every diff to the current project folder,
// even when the repository is much bigger (e.g. a home folder that is a repo).
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '-U3', '--relative'];
const HERE = ['--', '.'];
const MAX_UNTRACKED = 100;

/** Untracked (new, not ignored) text files in the project folder, as "new file" diffs. */
function untrackedDiff(cwd) {
  const files = createFileTools(cwd);
  const names = gitOk(['ls-files', '--others', '--exclude-standard', '-z', ...HERE], cwd)
    .split('\0')
    .filter((n) => n && !/(^|\/)(node_modules|\.git)\//.test(n))
    .slice(0, MAX_UNTRACKED);
  let out = '';
  for (const name of names) {
    const file = files.readFile(name);
    if (!file.ok) continue; // binary / too large / secret: skipped
    out += `diff --git a/${name} b/${name}\nnew file\n${createTwoFilesPatch('/dev/null', `b/${name}`, '', file.content, '', '').replace(/^=+\n/, '').replace(/\t$/gm, '')}`;
  }
  return out;
}

/** The repository's default branch (origin/HEAD, else main/master). */
function defaultBranch(root) {
  const remote = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root);
  if (remote.status === 0 && remote.stdout.trim()) return remote.stdout.trim();
  for (const name of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', name], root).status === 0) return name;
  }
  throw new ReviewError('BAD_TARGET', 'could not find the default branch (no origin/HEAD, main or master)');
}

const changedFiles = (diff) => [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]))];

/**
 * Gets what to review.
 * @param {string} [target] "uncommitted" (default) | "staged" | "branch" | a file path
 * @param {{ cwd?: string }} [opts]
 * @returns {{ target: string, kind: 'diff'|'code', text: string, files: string[], description: string }}
 * @throws {ReviewError}
 */
export function gitDiff(target = 'uncommitted', { cwd = process.cwd() } = {}) {
  repoRoot(cwd); // throws NOT_A_REPO
  // All git commands run in the project folder, with paths relative to it.
  const committed = hasCommits(cwd);
  const noChanges = (what) => {
    throw new ReviewError('NO_CHANGES', `no ${what} to review`);
  };

  if (target === 'uncommitted') {
    const tracked = committed
      ? gitOk(['diff', ...DIFF_FLAGS, 'HEAD', ...HERE], cwd)
      : gitOk(['diff', ...DIFF_FLAGS, '--cached', ...HERE], cwd) + gitOk(['diff', ...DIFF_FLAGS, ...HERE], cwd);
    const text = tracked + untrackedDiff(cwd);
    if (!text.trim()) noChanges('uncommitted changes');
    return { target, kind: 'diff', text, files: changedFiles(text), description: 'uncommitted changes' };
  }

  if (target === 'staged') {
    const text = gitOk(['diff', ...DIFF_FLAGS, '--cached', ...HERE], cwd);
    if (!text.trim()) noChanges('staged changes');
    return { target, kind: 'diff', text, files: changedFiles(text), description: 'staged changes' };
  }

  if (target === 'branch') {
    if (!committed) noChanges('commits');
    const base = defaultBranch(cwd);
    const text = gitOk(['diff', ...DIFF_FLAGS, `${base}...HEAD`, ...HERE], cwd);
    if (!text.trim()) noChanges(`changes compared with ${base}`);
    return { target, kind: 'diff', text, files: changedFiles(text), description: `this branch compared with ${base}` };
  }

  // A file path (sandboxed to the current folder).
  const files = createFileTools(cwd);
  const resolved = files.resolvePath(target);
  if (!resolved.ok) throw new ReviewError('BAD_TARGET', resolved.error);
  if (!fs.existsSync(resolved.abs)) {
    throw new ReviewError('BAD_TARGET', `"${target}" is not uncommitted, staged, branch or an existing file`);
  }
  const diff = committed ? gitOk(['diff', ...DIFF_FLAGS, 'HEAD', '--', resolved.rel], cwd) : '';
  if (diff.trim()) return { target, kind: 'diff', text: diff, files: [resolved.rel], description: `changes in ${resolved.rel}` };

  // No changes in that file: review the whole file instead.
  const file = files.readFile(target);
  if (!file.ok) throw new ReviewError('BAD_TARGET', file.error);
  return { target, kind: 'code', text: file.content, files: [resolved.rel], description: `the file ${resolved.rel}` };
}

// ---- Preparing text for the model ----------------------------------------------

/**
 * Prefixes diff lines with their new-file line number ("+ 12| code"), so the
 * model can cite real line numbers. Removed lines get "-   | ".
 */
export function annotateDiff(diff) {
  const out = [];
  let line = 0;
  for (const raw of diff.split('\n')) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      out.push(raw);
    } else if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff --git') || raw.startsWith('new file') || raw.startsWith('index ')) {
      out.push(raw);
    } else if (raw.startsWith('+')) {
      out.push(`+${String(line++).padStart(4)}| ${raw.slice(1)}`);
    } else if (raw.startsWith('-')) {
      out.push(`-    | ${raw.slice(1)}`);
    } else if (raw.startsWith(' ')) {
      out.push(` ${String(line++).padStart(4)}| ${raw.slice(1)}`);
    } else {
      out.push(raw);
    }
  }
  return out.join('\n');
}

/** "  12| code" numbering for whole-file review. */
export function numberLines(code) {
  return code
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
    .join('\n');
}

/** Splits a diff into per-file sections, grouped into chunks of at most CHUNK_CHARS. */
export function chunkDiff(diff, { chunkChars = CHUNK_CHARS, maxChunks = MAX_CHUNKS } = {}) {
  const sections = diff.split(/(?=^diff --git )/m).filter((s) => s.trim());
  const chunks = [];
  let current = '';
  let skipped = 0;
  for (let section of sections) {
    if (section.length > chunkChars) section = `${section.slice(0, chunkChars)}\n[… rest of this file's diff omitted …]\n`;
    if (current && current.length + section.length > chunkChars) {
      chunks.push(current);
      current = '';
    }
    current += section;
  }
  if (current) chunks.push(current);
  if (chunks.length > maxChunks) {
    skipped = chunks.slice(maxChunks).reduce((n, c) => n + Math.max(1, changedFiles(c).length), 0);
    chunks.length = maxChunks;
  }
  return { chunks, skippedFiles: skipped };
}

// ---- Prompt and parsing --------------------------------------------------------

function reviewerPrompt({ voice }) {
  const tone = voice === 'alderson' ? 'Write tersely and dryly.' : 'Write plainly and concisely.';
  return `You are Elliot, reviewing code for Prashanth (a JavaScript / Node.js / MySQL developer), following the Ponytail rules:
- Code should do only what the task needs: flag needless code, abstractions and dependencies.
- Validation, error handling, security and accessibility are never optional: flag anything that cuts them.

Report only real problems, mostly in changed lines (marked "+"). Use the file path and the line number shown before "|".
severity: "bug" (wrong result or crash), "security" (injection, secrets, unsafe input, missing auth), "perf" (slow, heavy load, memory), "test" (risky logic without tests), "style" (naming, clarity, needless code).
For every finding:
  what      = what the code does now
  why       = what goes wrong because of it
  fix       = the concrete fix
  ifIgnored = what happens if it is not fixed
Do not invent problems. If the code is fine, return an empty findings list. At most ${MAX_FINDINGS_PER_CALL} findings. ${tone}

Reply with JSON only, exactly this shape:
{"findings":[{"file":"src/app.js","line":12,"severity":"bug","what":"…","why":"…","fix":"…","ifIgnored":"…"}],"notChecked":"what you could not verify"}`;
}

const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

/** Normalises one finding from loosely-shaped model output; null if unusable. */
function normaliseFinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const what = str(raw.what ?? raw.issue ?? raw.problem ?? raw.description ?? raw.message);
  if (!what) return null;
  const severity = SEVERITY_ALIASES[str(raw.severity ?? raw.type ?? raw.category).toLowerCase()] ?? 'style';
  const lineNumber = Number.parseInt(raw.line ?? raw.lineNumber ?? raw.line_number, 10);
  return {
    file: str(raw.file ?? raw.path ?? raw.filename) || null,
    line: Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : null,
    severity,
    what,
    why: str(raw.why ?? raw.impact ?? raw.reason),
    fix: str(raw.fix ?? raw.suggestion ?? raw.recommendation),
    ifIgnored: str(raw.ifIgnored ?? raw.if_ignored ?? raw.ifignored ?? raw.consequence ?? raw.risk),
  };
}

/** Worst first: bug > security > perf > test > style, then by file and line. */
export function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

/**
 * Parses a model reply into findings, tolerating imperfect JSON.
 * @returns {{ findings: object[], notChecked: string|null, parseError: boolean }}
 */
export function parseFindings(text) {
  const parsed = parseLooseJson(String(text ?? '').replace(/^```(?:json)?\s*|\s*```\s*$/g, ''));
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return { findings: [], notChecked: null, parseError: true };
  }
  const list = Array.isArray(parsed) ? parsed : parsed.findings ?? parsed.issues ?? parsed.problems ?? [];
  const findings = (Array.isArray(list) ? list : []).map(normaliseFinding).filter(Boolean);
  const notChecked = Array.isArray(parsed) ? null : str(parsed.notChecked ?? parsed.not_checked ?? parsed.notchecked) || null;
  return { findings, notChecked, parseError: false };
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.file}|${f.line}|${f.severity}|${f.what.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Default model call: streams a JSON-mode reply and returns the text. */
async function defaultAsk({ model, system, user, signal, onProgress }) {
  const stream = chatStream({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], signal, json: true });
  let text = '';
  let result;
  while (!(result = await stream.next()).done) {
    text += result.value;
    onProgress?.({ type: 'tokens', chars: text.length });
  }
  return text;
}

/**
 * Reviews a diff or a piece of code.
 * @param {string | { kind: 'diff'|'code', text: string, files?: string[] }} input  gitDiff() result or raw diff text
 * @param {{ model?: string, voice?: string, signal?: AbortSignal, ask?: typeof defaultAsk,
 *           onProgress?: (e: object) => void }} [opts]
 * @returns {Promise<{ findings: object[], notChecked: string, raw: string[], parseErrors: number, skippedFiles: number }>}
 */
export async function review(input, { model = config.models.coder.name, voice = config.voice, signal, ask = defaultAsk, onProgress } = {}) {
  const target = typeof input === 'string' ? { kind: 'diff', text: input, files: [] } : input;
  if (!target?.text?.trim()) throw new TypeError('nothing to review');

  let chunks;
  let skippedFiles = 0;
  if (target.kind === 'code') {
    const name = target.files?.[0] ?? 'file';
    const code = target.text.length > CHUNK_CHARS ? `${target.text.slice(0, CHUNK_CHARS)}\n[… rest of file omitted …]` : target.text;
    chunks = [`File: ${name}\n${numberLines(code)}`];
  } else {
    ({ chunks, skippedFiles } = chunkDiff(target.text));
    chunks = chunks.map(annotateDiff);
  }

  const system = reviewerPrompt({ voice });
  const findings = [];
  const notes = [];
  const raw = [];
  let parseErrors = 0;
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ type: 'chunk', index: i, total: chunks.length });
    const what = target.kind === 'code' ? 'Review this file' : 'Review this diff';
    const text = await ask({ model, system, user: `${what}:\n\n${chunks[i]}`, signal, onProgress });
    const parsed = parseFindings(text);
    if (parsed.parseError) {
      parseErrors++;
      raw.push(text.trim());
    }
    findings.push(...parsed.findings);
    if (parsed.notChecked) notes.push(parsed.notChecked);
  }

  const notCheckedParts = [notes.length ? [...new Set(notes)].join('; ') : DEFAULT_NOT_CHECKED];
  if (skippedFiles) notCheckedParts.push(`${skippedFiles} more file(s) in the diff were not reviewed (size limit)`);
  return { findings: sortFindings(dedupe(findings)), notChecked: notCheckedParts.join('; '), raw, parseErrors, skippedFiles };
}

// ---- Audit ---------------------------------------------------------------------

/** Entry points from package.json: main, bin, exports, and "node <file>" scripts. */
export function entryPoints(root) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const found = [];
  const add = (p) => {
    if (typeof p === 'string' && /\.[cm]?[jt]sx?$/.test(p)) found.push(path.posix.normalize(p.replace(/^\.\//, '')));
  };
  add(pkg.main);
  if (typeof pkg.bin === 'string') add(pkg.bin);
  else Object.values(pkg.bin ?? {}).forEach(add);
  const walkExports = (e) => (typeof e === 'string' ? add(e) : e && typeof e === 'object' && Object.values(e).forEach(walkExports));
  walkExports(pkg.exports);
  for (const script of Object.values(pkg.scripts ?? {})) {
    for (const m of String(script).matchAll(/\bnode\s+(?:--[\w-]+\s+)*([\w./\\-]+\.[cm]?[jt]s)\b/g)) add(m[1].replace(/\\/g, '/'));
  }
  return [...new Set(found)];
}

/**
 * Picks the files an audit should look at, most important first:
 * entry points, then other source files by size (more code, more risk);
 * tests, build output and vendored code come last.
 */
export function rankAuditFiles(root, files) {
  const entries = entryPoints(root);
  const source = files.listFiles().files.filter((f) => SOURCE_EXT.has(f.slice(f.lastIndexOf('.') + 1).toLowerCase()));
  const size = (f) => {
    try {
      return fs.statSync(path.join(root, f)).size;
    } catch {
      return 0;
    }
  };
  const score = (f) => (entries.includes(f) ? 0 : LOW_PRIORITY.test(f) ? 2 : 1);
  return source.map((f) => ({ f, s: score(f), size: size(f) })).sort((a, b) => a.s - b.s || b.size - a.size).map((x) => x.f);
}

/**
 * Reviews the most important files of the project, a few at a time.
 * @param {{ cwd?: string, maxFiles?: number, filesPerBatch?: number, model?: string, voice?: string,
 *           signal?: AbortSignal, ask?: Function, onProgress?: (e: object) => void }} [opts]
 */
export async function audit({
  cwd = process.cwd(),
  maxFiles = 6,
  filesPerBatch = 2,
  model = config.models.coder.name,
  voice = config.voice,
  signal,
  ask = defaultAsk,
  onProgress,
} = {}) {
  const files = createFileTools(cwd);
  const ranked = rankAuditFiles(files.root, files);
  const chosen = ranked.slice(0, Math.max(0, maxFiles));

  // Batch files into chunks that fit one model call.
  const batches = [];
  let batch = [];
  let batchChars = 0;
  for (const rel of chosen) {
    const file = files.readFile(rel);
    if (!file.ok) continue;
    const content = file.content.length > CHUNK_CHARS ? `${file.content.slice(0, CHUNK_CHARS)}\n[… rest of file omitted …]` : file.content;
    const block = `File: ${rel}\n${numberLines(content)}\n`;
    if (batch.length && (batch.length >= filesPerBatch || batchChars + block.length > CHUNK_CHARS)) {
      batches.push(batch);
      batch = [];
      batchChars = 0;
    }
    batch.push({ rel, block });
    batchChars += block.length;
  }
  if (batch.length) batches.push(batch);

  const system = reviewerPrompt({ voice });
  const findings = [];
  const notes = [];
  let parseErrors = 0;
  for (let i = 0; i < batches.length; i++) {
    onProgress?.({ type: 'batch', index: i, total: batches.length, files: batches[i].map((b) => b.rel) });
    const text = await ask({ model, system, user: `Review these files:\n\n${batches[i].map((b) => b.block).join('\n')}`, signal, onProgress });
    const parsed = parseFindings(text);
    if (parsed.parseError) parseErrors++;
    findings.push(...parsed.findings);
    if (parsed.notChecked) notes.push(parsed.notChecked);
  }

  const reviewed = batches.flat().map((b) => b.rel);
  const skipped = ranked.length - reviewed.length;
  const notChecked = [
    skipped > 0 ? `${skipped} of ${ranked.length} source files were not reviewed (audit limit ${maxFiles})` : null,
    notes.length ? [...new Set(notes)].join('; ') : DEFAULT_NOT_CHECKED,
  ]
    .filter(Boolean)
    .join('; ');
  return { findings: sortFindings(dedupe(findings)), reviewed, skipped, totalSource: ranked.length, notChecked, parseErrors };
}

// ---- Debt ledger ---------------------------------------------------------------

/**
 * Finds "shortcut: …" comments (any line-comment style) across project files.
 * @param {{ cwd?: string, word?: string }} [opts]
 * @returns {{ path: string, line: number, note: string }[]}
 */
export function harvestDebt({ cwd = process.cwd(), word = 'shortcut' } = {}) {
  if (typeof word !== 'string' || !/^[\w-]{1,40}$/.test(word)) {
    throw new TypeError('debt word must be letters, digits, - or _ (max 40)');
  }
  const files = createFileTools(cwd);
  // After a comment marker: //, #, --, /*, *, <!--, ;
  const pattern = new RegExp(`(?:\\/\\/|#|--|\\/\\*|^\\s*\\*|<!--|;)\\s*${word}\\s*:`, 'i');
  const items = [];
  for (const rel of files.listFiles().files) {
    const file = files.readFile(rel);
    if (!file.ok) continue;
    file.content.split(/\r?\n/).forEach((text, i) => {
      // Ignore markers inside string literals ("// shortcut: …" in a test string is not debt).
      // Strings are blanked out with the same length, so positions still match the original line.
      const masked = text.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (s) => s[0] + ' '.repeat(s.length - 2) + s[0]);
      const m = masked.match(pattern);
      if (!m) return;
      const note = text
        .slice(m.index + m[0].length)
        .replace(/\s*(\*\/|-->)\s*$/, '')
        .trim();
      items.push({ path: rel, line: i + 1, note: note || '(no note)' });
    });
  }
  return items;
}

// ---- Formatting ----------------------------------------------------------------

const SEVERITY_LABEL = { bug: 'BUG', security: 'SECURITY', perf: 'PERF', test: 'TEST', style: 'STYLE' };
const SEVERITY_ANSI = { bug: '\x1b[31m', security: '\x1b[35m', perf: '\x1b[33m', test: '\x1b[36m', style: '\x1b[90m' };

/** "3 bugs, 2 perf, 5 style" */
export function summarize(findings) {
  if (findings.length === 0) return 'No problems found';
  const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(([, n]) => n > 0);
  return counts.map(([s, n]) => `${n} ${s === 'bug' && n !== 1 ? 'bugs' : s}`).join(', ');
}

/**
 * Human-readable report, grouped by severity (worst first), ending with "Not checked:".
 * @param {{ findings: object[], notChecked: string, raw?: string[] }} result
 * @param {{ color?: boolean, title?: string }} [opts]
 */
export function formatReport(result, { color = false, title } = {}) {
  const paint = (code, text) => (color ? `${code}${text}\x1b[0m` : text);
  const lines = [];
  if (title) lines.push(paint('\x1b[1m', title), '');
  lines.push(paint('\x1b[1m', summarize(result.findings)));
  for (const severity of SEVERITIES) {
    const group = result.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push('', paint(`\x1b[1m${SEVERITY_ANSI[severity]}`, `${SEVERITY_LABEL[severity]} (${group.length})`));
    for (const f of group) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '(general)';
      lines.push(`  ${paint(SEVERITY_ANSI[severity], '●')} ${paint('\x1b[1m', where)}  ${f.what}`);
      if (f.why) lines.push(`      why:        ${f.why}`);
      if (f.fix) lines.push(`      fix:        ${f.fix}`);
      if (f.ifIgnored) lines.push(`      if ignored: ${f.ifIgnored}`);
    }
  }
  if (result.raw?.length) {
    lines.push('', paint('\x1b[2m', 'The model replied in a form Elliot could not parse; its raw reply:'), ...result.raw.map((r) => r.slice(0, 2_000)));
  }
  lines.push('', paint('\x1b[2m', `Not checked: ${result.notChecked}`));
  return lines.join('\n');
}

/** Debt ledger as text. */
export function formatDebt(items, word = 'shortcut') {
  if (items.length === 0) return `No "${word}:" comments found.`;
  const width = Math.max(...items.map((i) => `${i.path}:${i.line}`.length));
  return [`${items.length} ${word}${items.length === 1 ? '' : 's'} to pay back`, '', ...items.map((i) => `  ${`${i.path}:${i.line}`.padEnd(width)}  ${i.note}`)].join('\n');
}
