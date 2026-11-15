// Full-screen UI + memory, using the real Session and an in-memory database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { html } from '../app/cli/tui/html.js';
import { App } from '../app/cli/tui/App.js';
import config from '../app/core/config.js';
import { Memory, projectFor } from '../app/core/memory.js';
import { Session } from '../app/core/session.js';

const ENTER = '\r';
const CWD = 'D:\\projects\\vaanijya';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function* fakeStream({ model }) {
  await wait(10);
  yield 'Use bcrypt.\n```js\nawait bcrypt.hash(pw, 12);\nNot checked: cost factor\n```';
  return { model, ms: 900, chars: 50, tokens: 9, tokensPerSec: 10 };
}

function setup(memory, props = {}) {
  const deps = {
    createSession: (opts) => new Session({ ...opts, stream: fakeStream }),
    listModels: async () => [config.models.coder.name],
    runCheck: async () => 0,
  };
  const app = render(html`<${App} cwd=${CWD} memory=${memory} deps=${deps} ...${props} />`);
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
      await wait(10);
    }
    await waitFor(`❯ ${text}`);
    app.stdin.write(ENTER);
    await wait(60);
  };
  return { ...app, frame, waitFor, send };
}

test('a chat is saved and shown again when the UI is reopened (continue across runs)', async (t) => {
  const memory = new Memory({ file: ':memory:', onWarn: () => {} });
  t.after(() => memory.close());

  const first = setup(memory);
  await first.send('how do I hash passwords?');
  await first.waitFor('last:');
  first.unmount();

  const second = setup(memory);
  t.after(() => second.unmount());
  await second.waitFor('Continuing chat #');
  const frame = second.frame();
  assert.match(frame, /“how do I hash passwords\?”/);
  assert.match(frame, /› how do I hash passwords\?/);
  assert.match(frame, /bcrypt\.hash/);
  // Seeded replies get the same "Not checked" fix as live ones.
  assert.ok(frame.indexOf('Not checked: cost factor') > frame.lastIndexOf('╰'));

  await second.send('/new');
  await second.waitFor('Type /help for commands');
  assert.doesNotMatch(second.frame(), /bcrypt/);
});

test('fresh=true starts a new conversation even if one exists', async (t) => {
  const memory = new Memory({ file: ':memory:', onWarn: () => {} });
  t.after(() => memory.close());
  const id = memory.newConversation(projectFor(CWD));
  memory.addMessage(id, 'user', 'old question');

  const ui = setup(memory, { fresh: true });
  t.after(() => ui.unmount());
  await ui.waitFor('Type /help for commands');
  assert.doesNotMatch(ui.frame(), /old question/);
});

test('/remember, /facts and /history', async (t) => {
  const memory = new Memory({ file: ':memory:', onWarn: () => {} });
  t.after(() => memory.close());
  const ui = setup(memory);
  t.after(() => ui.unmount());

  await ui.send('/remember stack: Node + MySQL');
  await ui.waitFor('Remembered: stack = Node + MySQL');
  assert.equal(memory.getFacts(projectFor(CWD))[0].value, 'Node + MySQL');

  await ui.send('/remember no colon');
  await ui.waitFor('Usage: /remember key: value');

  await ui.send('/facts');
  await ui.waitFor('Notes for this project');
  assert.match(ui.frame(), /stack\s+Node \+ MySQL/);

  await ui.send('/history');
  await ui.waitFor('No saved conversations for this project yet.');
  await ui.send('write a password hash helper');
  await ui.waitFor('last:');
  await ui.send('/history');
  await ui.waitFor('LAST ACTIVE');
  assert.match(ui.frame(), /\*\d+\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+2\s+write a password hash helper/);
});

test('a memory warning is shown inside the UI', async (t) => {
  const memory = new Memory({ file: ':memory:', onWarn: () => {} });
  memory.warning = 'memory database unavailable (SQLITE_BUSY) — using temporary memory for this run';
  t.after(() => memory.close());
  const ui = setup(memory);
  t.after(() => ui.unmount());
  await ui.waitFor('memory database unavailable (SQLITE_BUSY)');
});
