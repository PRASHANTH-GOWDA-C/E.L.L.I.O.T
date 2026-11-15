// Where Elliot lives on disk — resolved from the location of the running
// code, never from the current working directory. So memory/elliot.db always
// stays with Elliot (on the pendrive or in the repo), whatever project folder
// you run `elliot` in. Per-project memory is still keyed by cwd (memory.js).
//
// Two layouts are supported:
//   repo      <repo>/start-elliot.bat, <repo>/app, <repo>/models, …   (SSD / git checkout)
//   pendrive  <drive>/start-elliot.bat, <drive>/elliot/app, <drive>/elliot/models, …
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'elliot';

function isElliotRoot(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Walks up from a file or folder to the folder holding Elliot's package.json.
 * @param {string} from a path inside Elliot (it need not exist, e.g. in tests)
 */
export function findElliotRoot(from) {
  let dir = path.resolve(from);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  for (;;) {
    if (isElliotRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot find Elliot's folder above ${from}`);
    dir = parent;
  }
}

/**
 * @param {string} [from] a path inside Elliot; defaults to this file
 * @returns {{ root: string, layout: 'repo'|'pendrive', app: string, bin: string, web: string,
 *            memory: string, dbFile: string, models: string, runtime: string, launcher: string }}
 */
export function resolvePaths(from = fileURLToPath(import.meta.url)) {
  const root = findElliotRoot(from);
  const parent = path.dirname(root);
  // Pendrive: the launcher sits one level up, next to an "elliot" folder.
  const pendrive = path.basename(root).toLowerCase() === 'elliot' && fs.existsSync(path.join(parent, 'start-elliot.bat'));
  const memory = path.join(root, 'memory');
  return {
    root,
    layout: pendrive ? 'pendrive' : 'repo',
    app: path.join(root, 'app'),
    bin: path.join(root, 'bin'),
    web: path.join(root, 'app', 'web'),
    memory,
    dbFile: path.join(memory, 'elliot.db'),
    models: path.join(root, 'models'),
    runtime: path.join(root, 'runtime'),
    launcher: path.join(pendrive ? parent : root, 'start-elliot.bat'),
  };
}
