// File tools, sandboxed to one project folder.
//
// Safety rules enforced here (not just in prompts):
//   • Every path is resolved against the project root; anything that ends up
//     outside it (../, absolute paths, symlinks/junctions) is rejected.
//   • .git and node_modules are never read, listed or written; secret files
//     (.env, private keys) are never read or written.
//   • proposeEdit never writes. applyEdit is the ONLY function that writes, and
//     it refuses unless called with { confirmed: true } — callers pass that only
//     after the user pressed y (or used --yes).
//   • There is no delete function.
//
// Every function returns a result object: { ok: true, ... } or
// { ok: false, code, error } — never throws for user-caused problems.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import ignore from 'ignore';

export const MAX_FILE_BYTES = 256 * 1024;
const MAX_LIST_RESULTS = 2_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_MATCH_TEXT = 200;
const BINARY_SNIFF_BYTES = 8_000;

const NEVER_TOUCH_DIRS = new Set(['.git', 'node_modules']);
// .env, .env.local … but not .env.example / .env.sample / .env.template
const SECRET_FILE = /^(\.env(\.(?!example$|sample$|template$)[^/\\]+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx))$/i;

const fail = (code, error) => ({ ok: false, code, error });
const toPosix = (p) => p.split(path.sep).join('/');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Nearest existing ancestor (or the path itself) — used to resolve symlinks for new files. */
function nearestExisting(p) {
  let current = p;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isBinary(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** "src/**\/*.js" style glob → RegExp. Patterns without "/" match the file name anywhere. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // "**/" matches zero or more folders
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += `(?:${glob.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
        i = end;
      }
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Creates the tool set for one project folder.
 * @param {string} rootDir project root (usually process.cwd())
 */
export function createFileTools(rootDir) {
  const root = fs.realpathSync(path.resolve(rootDir));

  /**
   * Resolves a user/model-supplied path safely.
   * @returns {{ ok: true, abs: string, rel: string } | { ok: false, code: string, error: string }}
   */
  function resolvePath(input) {
    if (typeof input !== 'string' || input.trim() === '') return fail('BAD_PATH', 'path must be a non-empty string');
    if (input.includes('\0')) return fail('BAD_PATH', 'path contains a NUL character');

    const abs = path.resolve(root, input.trim());
    if (!isInside(root, abs)) return fail('OUTSIDE_PROJECT', `${input} is outside the project folder (${root})`);

    // Follow symlinks/junctions: the real location must also be inside.
    let real;
    try {
      const existing = nearestExisting(abs);
      real = path.join(fs.realpathSync(existing), path.relative(existing, abs));
    } catch (err) {
      return fail('BAD_PATH', `cannot resolve ${input}: ${err.code ?? err.message}`);
    }
    if (!isInside(root, real)) return fail('OUTSIDE_PROJECT', `${input} points outside the project folder`);

    const rel = toPosix(path.relative(root, abs));
    const parts = rel.split('/');
    if (parts.some((part) => NEVER_TOUCH_DIRS.has(part.toLowerCase()))) {
      return fail('FORBIDDEN', `${rel} is inside .git or node_modules, which Elliot never touches`);
    }
    if (SECRET_FILE.test(parts.at(-1))) {
      return fail('FORBIDDEN', `${rel} looks like a secrets file; Elliot doesn't read or write it`);
    }
    return { ok: true, abs, rel: rel || '.' };
  }

  /** Reads a small text file. Internal: shared by readFile and proposeEdit. */
  function readText(resolved) {
    let stat;
    try {
      stat = fs.statSync(resolved.abs);
    } catch (err) {
      if (err.code === 'ENOENT') return fail('NOT_FOUND', `${resolved.rel} does not exist`);
      return fail('READ_ERROR', `cannot read ${resolved.rel}: ${err.code ?? err.message}`);
    }
    if (!stat.isFile()) return fail('NOT_A_FILE', `${resolved.rel} is not a file`);
    if (stat.size > MAX_FILE_BYTES) {
      return fail('TOO_LARGE', `${resolved.rel} is ${Math.round(stat.size / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB`);
    }
    const buffer = fs.readFileSync(resolved.abs);
    if (isBinary(buffer)) return fail('BINARY', `${resolved.rel} looks like a binary file`);
    return { ok: true, content: buffer.toString('utf8'), bytes: stat.size };
  }

  /** @returns {{ ok: true, path, absolutePath, content, bytes } | { ok: false, code, error }} */
  function readFile(filePath) {
    const resolved = resolvePath(filePath);
    if (!resolved.ok) return resolved;
    const text = readText(resolved);
    if (!text.ok) return text;
    return { ok: true, path: resolved.rel, absolutePath: resolved.abs, content: text.content, bytes: text.bytes };
  }

  /**
   * Lists project files (POSIX-style relative paths), honouring every
   * .gitignore in the tree. Never descends into .git, node_modules or symlinks.
   * @param {string} [glob] e.g. "*.js", "src/**\/*.{js,ts}"
   */
  function listFiles(glob) {
    let matcher = null;
    if (glob !== undefined && glob !== null && glob !== '') {
      if (typeof glob !== 'string') return fail('BAD_GLOB', 'glob must be a string');
      const re = globToRegExp(glob);
      matcher = glob.includes('/') ? (rel) => re.test(rel) : (rel) => re.test(rel.slice(rel.lastIndexOf('/') + 1));
    }

    const files = [];
    let truncated = false;
    // Stack of .gitignore matchers: { base: 'src/', ig }.
    const walk = (dirRel, ignores) => {
      const dirAbs = path.join(root, dirRel);
      let entries;
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return; // unreadable folder: skip
      }
      const gitignore = entries.find((e) => e.isFile() && e.name === '.gitignore');
      if (gitignore) {
        try {
          const ig = ignore().add(fs.readFileSync(path.join(dirAbs, '.gitignore'), 'utf8'));
          ignores = [...ignores, { base: dirRel ? `${dirRel}/` : '', ig }];
        } catch {
          // unreadable .gitignore: ignore it
        }
      }
      const isIgnored = (rel, isDir) =>
        ignores.some(({ base, ig }) => rel.startsWith(base) && ig.ignores(rel.slice(base.length) + (isDir ? '/' : '')));

      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (truncated) return;
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (NEVER_TOUCH_DIRS.has(entry.name.toLowerCase()) || isIgnored(rel, true)) continue;
          walk(rel, ignores);
        } else if (entry.isFile()) {
          if (isIgnored(rel, false) || SECRET_FILE.test(entry.name)) continue;
          if (matcher && !matcher(rel)) continue;
          if (files.length >= MAX_LIST_RESULTS) {
            truncated = true;
            return;
          }
          files.push(rel);
        }
      }
    };
    walk('', []);
    return { ok: true, root, files, truncated };
  }

  /**
   * Plain-text search across project files (like ripgrep): smart case —
   * case-insensitive unless the query has an uppercase letter.
   * @returns {{ ok: true, matches: { path, line, text }[], truncated } | { ok: false, code, error }}
   */
  function searchFiles(query, { glob } = {}) {
    if (typeof query !== 'string' || query.trim() === '') return fail('BAD_QUERY', 'query must be a non-empty string');
    const listed = listFiles(glob);
    if (!listed.ok) return listed;

    const caseSensitive = /[A-Z]/.test(query);
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches = [];
    for (const rel of listed.files) {
      const text = readText({ abs: path.join(root, rel), rel });
      if (!text.ok) continue; // binary / too large: skip
      const lines = text.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
        if (!line.includes(needle)) continue;
        const shown = lines[i].trim();
        matches.push({ path: rel, line: i + 1, text: shown.length > MAX_MATCH_TEXT ? `${shown.slice(0, MAX_MATCH_TEXT)}…` : shown });
        if (matches.length >= MAX_SEARCH_RESULTS) return { ok: true, matches, truncated: true };
      }
    }
    return { ok: true, matches, truncated: listed.truncated };
  }

  /**
   * Shows what a change would look like. NEVER writes.
   * @returns {{ ok: true, path, absolutePath, isNew, changed, diff, additions, deletions, baseHash, newContent }
   *   | { ok: false, code, error }}
   */
  function proposeEdit(filePath, newContent) {
    if (typeof newContent !== 'string') return fail('BAD_CONTENT', 'new content must be a string');
    if (Buffer.byteLength(newContent) > MAX_FILE_BYTES) return fail('TOO_LARGE', 'new content is over the 256 KB limit');
    if (newContent.includes('\0')) return fail('BAD_CONTENT', 'new content contains a NUL character (binary?)');
    const resolved = resolvePath(filePath);
    if (!resolved.ok) return resolved;

    let original = '';
    let isNew = false;
    const current = readText(resolved);
    if (current.ok) original = current.content;
    else if (current.code === 'NOT_FOUND') isNew = true;
    else return current;

    // Keep the file's line endings: models write "\n", Windows files may use "\r\n".
    let proposed = newContent;
    if (!isNew && original.includes('\r\n')) proposed = proposed.replace(/\r?\n/g, '\r\n');

    const diff = createTwoFilesPatch(isNew ? '/dev/null' : `a/${resolved.rel}`, `b/${resolved.rel}`, original, proposed, '', '', {
      context: 3,
    })
      .replace(/^=+\n/, '') // drop the "=====" banner; keep git-style headers
      .replace(/\t$/gm, ''); // empty header timestamps leave a trailing tab
    const lines = diff.split('\n');
    return {
      ok: true,
      path: resolved.rel,
      absolutePath: resolved.abs,
      isNew,
      changed: original !== proposed,
      diff,
      additions: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
      deletions: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
      // Lets applyEdit refuse if the file changed after the diff was shown.
      baseHash: isNew ? null : sha256(original),
      newContent: proposed,
    };
  }

  /**
   * Writes a file. The ONLY writing function. Refuses unless `confirmed` is
   * exactly true (the user pressed y / passed --yes). If `baseHash` is given,
   * refuses when the file changed since the diff was shown. Never deletes.
   * @param {string} filePath
   * @param {string} newContent
   * @param {{ confirmed?: boolean, baseHash?: string|null }} [opts]
   */
  function applyEdit(filePath, newContent, { confirmed = false, baseHash } = {}) {
    if (confirmed !== true) return fail('NOT_CONFIRMED', 'refusing to write: the change was not confirmed');
    if (typeof newContent !== 'string') return fail('BAD_CONTENT', 'new content must be a string');
    if (Buffer.byteLength(newContent) > MAX_FILE_BYTES) return fail('TOO_LARGE', 'new content is over the 256 KB limit');
    const resolved = resolvePath(filePath);
    if (!resolved.ok) return resolved;

    const exists = fs.existsSync(resolved.abs);
    if (exists && !fs.statSync(resolved.abs).isFile()) return fail('NOT_A_FILE', `${resolved.rel} is not a file`);
    if (baseHash !== undefined) {
      const current = exists ? readText(resolved) : null;
      if (current && !current.ok) return current;
      const currentHash = current ? sha256(current.content) : null;
      if (currentHash !== baseHash) {
        return fail('CHANGED', `${resolved.rel} changed after the diff was shown; not writing — ask again for a fresh diff`);
      }
    }

    // Write to a temp file, then rename: a pulled USB drive never leaves half a file.
    const temp = path.join(path.dirname(resolved.abs), `.elliot-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(path.dirname(resolved.abs), { recursive: true });
      fs.writeFileSync(temp, newContent, 'utf8');
      fs.renameSync(temp, resolved.abs);
    } catch (err) {
      // Only ever removes Elliot's own temp file, never a user file.
      fs.rmSync(temp, { force: true });
      return fail('WRITE_ERROR', `cannot write ${resolved.rel}: ${err.code ?? err.message}`);
    }
    return { ok: true, path: resolved.rel, absolutePath: resolved.abs, bytes: Buffer.byteLength(newContent), created: !exists };
  }

  return { root, resolvePath, readFile, listFiles, searchFiles, proposeEdit, applyEdit };
}
