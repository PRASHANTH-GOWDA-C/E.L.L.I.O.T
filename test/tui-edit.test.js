// /edit in the full-screen UI: diff panel + y/n gate, with real file tools on a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { html } from '../app/cli/tui/html.js';
import { App } from '../app/cli/tui/App.js';
import config from '../app/core/config.js';
import { createFileTools } from '../app/core/tools/files.js';

const ENTER = '\r';
const ESC = '\x1b';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ORIGINAL = 'export const port = 3000;\n';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elliot-tui-edit-'));
  fs.writeFileSync(path.join(root, 'server.js'), ORIGINAL);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Fake agent: proposes a real diff through the real file tools, like the model would.
  const runAgent = async ({ files, onEvent }) => {
    onEvent({ type: 'tool', name: 'read_file', summary: 'server.js', ok: true });
    const proposal = files.proposeEdit('server.js', 'export const port = Number(process.env.PORT) || 3000;\n');
    return { answer: 'Read the port from the environment.', proposals: [proposal], fallback: false };
  };
  const deps = {
    createSession: () => ({ history: [], model: '', project: root, send: async function* () {} }),
    listModels: async () => [config.models.coder.name],
    runCheck: async () => 0,
    runAgent,
    createFileTools,
  };
  const app = render(html`<${App} cwd=${root} deps=${deps} />`);
  const frame = () => app.lastFrame() ?? '';
  const waitFor = async (text, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (!frame().includes(text)) {
      if (Date.now() > deadline) assert.fail(`Timed out waiting for "${text}". Last frame:\n${frame()}`);
      await wait(20);
    }
  };
  const type = async (text) => {
    for (const ch of text) {
      app.stdin.write(ch);
      await wait(8);
    }
  };
  const press = async (key) => {
    app.stdin.write(key);
    await wait(80);
  };
  t.after(() => app.unmount());
  return { root, frame, waitFor, type, press };
}

const fileContent = (root) => fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('/edit shows the diff panel; n leaves the file untouched', async (t) => {
  const ui = setup(t);
  await ui.type('/edit read the port from env');
  await ui.waitFor('❯ /edit read the port from env');
  await ui.press(ENTER);
  await ui.waitFor('Apply this change? [y/N]');
  const frame = ui.frame();
  assert.match(frame, /Proposed change: .*server\.js/);
  assert.match(frame, /-export const port = 3000;/);
  assert.match(frame, /\+export const port = Number\(process\.env\.PORT\) \|\| 3000;/);
  assert.match(frame, /review the change/);

  // Random keys do nothing; only y writes.
  await ui.type('xq');
  assert.equal(fileContent(ui.root), ORIGINAL);

  await ui.press('n');
  await ui.waitFor('Not applied:');
  assert.equal(fileContent(ui.root), ORIGINAL);
  assert.doesNotMatch(ui.frame(), /Apply this change/);
});

test('/edit: Esc also declines', async (t) => {
  const ui = setup(t);
  await ui.type('/edit x');
  await ui.waitFor('❯ /edit x');
  await ui.press(ENTER);
  await ui.waitFor('Apply this change? [y/N]');
  await ui.press(ESC);
  await ui.waitFor('Not applied:');
  assert.equal(fileContent(ui.root), ORIGINAL);
});

test('/edit: y writes the file and shows the absolute path', async (t) => {
  const ui = setup(t);
  await ui.type('/edit read the port from env');
  await ui.waitFor('❯ /edit read the port from env');
  await ui.press(ENTER);
  await ui.waitFor('Apply this change? [y/N]');
  await ui.press('y');
  await ui.waitFor('✔ Wrote');
  assert.ok(ui.frame().includes(path.join(fs.realpathSync(ui.root), 'server.js').slice(-30)));
  assert.equal(fileContent(ui.root), 'export const port = Number(process.env.PORT) || 3000;\n');
});
