// Syntax check for proposed JavaScript edits, using Node's own parser
// (`node --check`), so a model can't propose an edit that breaks the file.
import { spawnSync } from 'node:child_process';

const CHECKABLE = /\.(m?js|cjs)$/i; // JSX/TypeScript need other parsers: not checked

function nodeCheck(content, inputType) {
  const r = spawnSync(process.execPath, [`--input-type=${inputType}`, '--check'], {
    input: content,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (r.error) return null; // couldn't run the check: don't block the edit
  if (r.status === 0) return null;
  const lines = r.stderr.split(/\r?\n/);
  const where = lines.find((l) => /^\[stdin\]:\d+/.test(l))?.match(/:(\d+)/)?.[1];
  const message = lines.find((l) => /^\w*Error:/.test(l)) ?? 'syntax error';
  return where ? `${message} (line ${where})` : message;
}

/**
 * @param {string} filePath used only for the extension
 * @param {string} content
 * @returns {string|null} the syntax error, or null if valid (or not a checkable file)
 */
export function checkSyntax(filePath, content) {
  if (!CHECKABLE.test(filePath)) return null;
  const preferred = /\.cjs$/i.test(filePath) ? ['commonjs', 'module'] : ['module', 'commonjs'];
  // Valid as either an ES module or CommonJS counts as valid (a .js file can be either).
  const first = nodeCheck(content, preferred[0]);
  if (first === null) return null;
  return nodeCheck(content, preferred[1]) === null ? null : first;
}
