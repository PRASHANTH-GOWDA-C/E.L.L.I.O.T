// /review, /audit and /debt in the full-screen UI (fake model, temp folder).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { html } from '../app/cli/tui/html.js';
import { App } from '../app/cli/tui/App.js';
import config from '../app/core/config.js';
import { ReviewError, harvestDebt } from '../app/core/review.js';

const ENTER = '\r';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elliot-tui-review-'));
  fs.writeFileSync(path.join(root, 'app.js'), 'const limit = 10; // shortcut: hard-coded limit\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const finding = { file: 'app.js', line: 1, severity: 'bug', what: 'subtracts instead of adds', why: 'wrong totals', fix: 'use +', ifIgnored: 'bad invoices' };
  const deps = {
    createSession: () => ({ history: [], model: '', project: root, send: async function* () {} }),
    listModels: async () => [config.models.coder.name],
    runCheck: async () => 0,
    gitDiff: () => ({ target: 'uncommitted', kind: 'diff', text: 'diff', files: ['app.js'], description: 'uncommitted changes' }),
    review: async () => ({ findings: [finding], notChecked: 'not executed.', raw: [] }),
    audit: async () => ({ findings: [finding, { ...finding, severity: 'style', what: 'name' }], reviewed: ['app.js'], totalSource: 1, notChecked: 'not executed.' }),
    harvestDebt,
    ...overrides,
  };
  const app = render(html`<${App} cwd=${root} deps=${deps} />`);
  t.after(() => app.unmount());
  const frame = () => app.lastFrame() ?? '';
  const waitFor = async (text, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (!frame().includes(text)) {
      if (Date.now() > deadline) assert.fail(`Timed out waiting for "${text}". Last frame:\n${frame()}`);
      await wait(20);
    }
  };
  const send = async (text) => {
    for (const ch of text) {
      app.stdin.write(ch);
      await wait(8);
    }
    await waitFor(`❯ ${text}`);
    app.stdin.write(ENTER);
    await wait(60);
  };
  return { frame, waitFor, send };
}

test('/review shows findings grouped by severity with what/why/fix/if ignored', async (t) => {
  const ui = setup(t);
  await ui.send('/review');
  await ui.waitFor('Not checked: not executed.');
  const frame = ui.frame();
  assert.match(frame, /Review of uncommitted changes/);
  assert.match(frame, /1 bug/);
  assert.match(frame, /BUG \(1\)/);
  assert.match(frame, /app\.js:1  subtracts instead of adds/);
  assert.match(frame, /if ignored: bad invoices/);
  assert.match(frame, /ready/);
});

test('/review with nothing to review says so', async (t) => {
  const ui = setup(t, {
    gitDiff: () => {
      throw new ReviewError('NO_CHANGES', 'no uncommitted changes');
    },
  });
  await ui.send('/review');
  await ui.waitFor('Nothing to review: no uncommitted changes.');
});

test('/audit shows the one-line summary first', async (t) => {
  const ui = setup(t);
  await ui.send('/audit');
  await ui.waitFor('1 bug, 1 style — 1 of 1 source files reviewed');
});

test('/debt lists shortcut comments with file:line', async (t) => {
  const ui = setup(t);
  await ui.send('/debt');
  await ui.waitFor('1 shortcut to pay back');
  assert.match(ui.frame(), /app\.js:1\s+hard-coded limit/);
});
