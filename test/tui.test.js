import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { html } from '../app/cli/tui/html.js';
import { App } from '../app/cli/tui/App.js';
import config from '../app/core/config.js';
import { LlmError } from '../app/core/llm.js';

const ESC = '\x1b';
const ENTER = '\r';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Fake Session: streams a reply with the "Not checked" line inside the code block. */
class FakeSession {
  static instances = [];
  constructor({ model }) {
    this.model = model;
    this.sent = [];
    FakeSession.instances.push(this);
  }
  async *send(text, { signal } = {}) {
    this.sent.push({ text, model: this.model });
    const slow = text === 'slow';
    const chunks = slow ? Array(500).fill('word ') : ['Here:\n```js\nconst x = 1;\n', 'Not checked: tests\n```'];
    for (const chunk of chunks) {
      await wait(slow ? 20 : 10);
      if (signal?.aborted) throw new LlmError('ABORTED', 'Stopped');
      yield chunk;
    }
    return { model: this.model, ms: 1234, chars: 40, tokens: 12, tokensPerSec: 4.2 };
  }
}

function setup({ installed = ['qwen2.5-coder:7b', 'qwen3:4b'] } = {}) {
  let exited = false;
  const deps = {
    createSession: (opts) => new FakeSession(opts),
    listModels: async () => installed,
    runCheck: async ({ print }) => {
      print('E.L.L.I.O.T system check');
      print('Ollama:     ✅ online');
      return 0;
    },
  };
  const app = render(html`<${App} cwd="D:\\projects\\my-app" deps=${deps} onExit=${() => (exited = true)} />`);
  const frame = () => app.lastFrame() ?? '';

  /** Polls until the frame matches (string or RegExp), or fails after `timeout` ms. */
  const waitFor = async (pattern, { timeout = 3000, not = false } = {}) => {
    const matches = () => (typeof pattern === 'string' ? frame().includes(pattern) : pattern.test(frame()));
    const deadline = Date.now() + timeout;
    while (matches() === not) {
      if (Date.now() > deadline) {
        assert.fail(`Timed out waiting for ${not ? 'absence of ' : ''}${pattern}. Last frame:\n${frame()}`);
      }
      await wait(20);
    }
  };
  // Keys are sent one by one, waiting for each to render (as a human would).
  const type = async (text) => {
    for (const ch of text) {
      app.stdin.write(ch);
      await wait(15);
    }
  };
  const press = async (key) => {
    app.stdin.write(key);
    await wait(60);
  };
  return { ...app, frame, waitFor, type, press, exited: () => exited };
}

test('header shows name, model, mode and folder', async (t) => {
  const ui = setup();
  t.after(() => ui.unmount());
  await ui.waitFor('-- INSERT --');
  const frame = ui.frame();
  assert.match(frame, /E\.L\.L\.I\.O\.T/);
  assert.match(frame, new RegExp(`${escapeRe(config.models.coder.name)} \\(coder\\)`));
  assert.match(frame, new RegExp(config.aiMode));
  assert.match(frame, /my-app/);
  assert.match(frame, /ready/);
});

test('sending a message streams the reply, fixes "Not checked" and shows stats', async (t) => {
  const ui = setup();
  t.after(() => ui.unmount());
  await ui.type('hello');
  await ui.waitFor('❯ hello');
  await ui.press(ENTER);
  await ui.waitFor(/last: 1\.2s · 4\.2 tok\/s/);
  const frame = ui.frame();
  assert.match(frame, /› hello/);
  assert.match(frame, /Elliot/);
  assert.match(frame, /│ js/);
  assert.match(frame, /const x = 1;/);
  // "Not checked" must come after the code block's bottom border, not inside it.
  const borderEnd = frame.lastIndexOf('╰');
  const notChecked = frame.indexOf('Not checked: tests');
  assert.ok(borderEnd !== -1 && notChecked > borderEnd, `Not checked should follow the code block:\n${frame}`);
  assert.match(frame, /ready/);
});

test('Esc while idle → NORMAL, i → INSERT, :q quits', async (t) => {
  const ui = setup();
  t.after(() => ui.unmount());
  await ui.waitFor('-- INSERT --');
  await ui.press(ESC);
  await ui.waitFor('-- NORMAL --');
  await ui.type('i');
  await ui.waitFor('-- INSERT --');
  await ui.press(ESC);
  await ui.waitFor('-- NORMAL --');
  await ui.type(':q');
  await ui.waitFor(/^:q/m);
  await ui.press(ENTER);
  assert.equal(ui.exited(), true);
});

test('unknown :command shows an error and does not quit', async (t) => {
  const ui = setup();
  t.after(() => ui.unmount());
  await ui.waitFor('-- INSERT --');
  await ui.press(ESC);
  await ui.waitFor('-- NORMAL --');
  await ui.type(':wat');
  await ui.waitFor(':wat');
  await ui.press(ENTER);
  await ui.waitFor('Not an editor command: wat');
  assert.equal(ui.exited(), false);
});

test('Esc while streaming stops the reply', async (t) => {
  const ui = setup();
  t.after(() => ui.unmount());
  await ui.type('slow');
  await ui.waitFor('❯ slow');
  await ui.press(ENTER);
  await ui.waitFor('streaming');
  await ui.press(ESC);
  await ui.waitFor('[stopped]');
  const frame = ui.frame();
  assert.match(frame, /-- INSERT --  stopped/); // Esc stopped the reply instead of switching mode
});

test('/help lists commands', async (t) => {
  const ui = setup();
  t.after(() => ui.unmount());
  await ui.type('/help');
  await ui.waitFor('❯ /help');
  await ui.press(ENTER);
  await ui.waitFor('/model coder|fast|reason');
  for (const cmd of ['/clear', '/models', '/quit', ':q quit']) assert.ok(ui.frame().includes(cmd), cmd);
});

test('/model reason when not installed shows the pull command', async (t) => {
  const ui = setup();
  t.after(() => ui.unmount());
  await ui.type('/model reason');
  await ui.waitFor('❯ /model reason');
  await ui.press(ENTER);
  await ui.waitFor(`ollama pull ${config.models.reason.name}`);
  assert.match(ui.frame(), /\(coder\)/);
});

test('/model fast switches the header and the next message uses it', async (t) => {
  FakeSession.instances = [];
  const ui = setup();
  t.after(() => ui.unmount());
  await ui.type('/model fast');
  await ui.waitFor('❯ /model fast');
  await ui.press(ENTER);
  await ui.waitFor('(fast)');
  await ui.type('hi');
  await ui.waitFor('❯ hi');
  await ui.press(ENTER);
  await ui.waitFor('last:');
  assert.equal(FakeSession.instances[0].sent[0].model, config.models.fast.name);
});

test('/models shows the check report and /clear empties the conversation', async (t) => {
  const ui = setup();
  t.after(() => ui.unmount());
  await ui.type('/models');
  await ui.waitFor('❯ /models');
  await ui.press(ENTER);
  await ui.waitFor('system check');
  await ui.type('/clear');
  await ui.waitFor('❯ /clear');
  await ui.press(ENTER);
  await ui.waitFor('system check', { not: true });
  assert.match(ui.frame(), /Type \/help for commands/);
});

test('/quit quits', async (t) => {
  const ui = setup();
  t.after(() => ui.unmount());
  await ui.type('/quit');
  await ui.waitFor('❯ /quit');
  await ui.press(ENTER);
  assert.equal(ui.exited(), true);
});

test('NORMAL mode: g jumps to the top, G back to the newest message', async (t) => {
  const ui = setup();
  t.after(() => ui.unmount());
  // Fill the screen with more lines than fit (default test terminal: 24 rows).
  for (let i = 0; i < 4; i++) {
    await ui.type('/help');
    await ui.waitFor('❯ /help');
    await ui.press(ENTER);
  }
  await ui.waitFor('Anywhere Ctrl+C quits');
  const bottom = ui.frame();
  await ui.press(ESC);
  await ui.waitFor('-- NORMAL --');
  await ui.type('g');
  await ui.waitFor(/Commands/);
  assert.notEqual(ui.frame(), bottom);
  assert.doesNotMatch(ui.frame(), /Anywhere Ctrl\+C quits\s*\n\s*-- NORMAL/);
  await ui.type('G');
  await ui.waitFor(/Anywhere Ctrl\+C quits\s*\n+-- NORMAL/);
});
