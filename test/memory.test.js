import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { GLOBAL_PROJECT, Memory, makeTitle, parseFact, projectFor } from '../app/core/memory.js';
import { Session } from '../app/core/session.js';

const PROJECT_A = 'd:\\projects\\vaanijya';
const PROJECT_B = 'd:\\projects\\other';

/** A Memory on a fresh temp file; deleted after the test. */
function tempMemory(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elliot-mem-'));
  const file = path.join(dir, 'elliot.db');
  const warnings = [];
  const memory = new Memory({ file, onWarn: (w) => warnings.push(w), ...opts });
  t.after(() => {
    memory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { memory, file, warnings };
}

/** Fake chatStream: yields a canned reply, no Ollama. */
function fakeStream(reply = 'Sure.\n```js\nok();\n```\n\nNot checked: tests.') {
  return async function* stream({ model }) {
    yield reply;
    return { model, ms: 10, chars: reply.length, tokens: 5, tokensPerSec: 500 };
  };
}

async function drain(generator) {
  let result;
  while (!(result = await generator.next()).done);
  return result.value;
}

test('memory: conversations and messages round-trip, with auto title', (t) => {
  const { memory, file, warnings } = tempMemory(t);
  const id = memory.newConversation(PROJECT_A);
  assert.equal(typeof id, 'number');
  memory.addMessage(id, 'user', 'How do I paginate a MySQL query in Node quickly?');
  memory.addMessage(id, 'assistant', 'Use LIMIT and OFFSET…', 'qwen2.5-coder:7b');

  const { conversation, messages } = memory.getConversation(id);
  assert.equal(conversation.project, PROJECT_A);
  assert.equal(conversation.title, 'How do I paginate a MySQL'); // first 6 words
  assert.deepEqual(
    messages.map((m) => [m.role, m.model]),
    [
      ['user', null],
      ['assistant', 'qwen2.5-coder:7b'],
    ],
  );
  // Title is only set from the first user message.
  memory.addMessage(id, 'user', 'something else entirely now');
  assert.equal(memory.getConversation(id).conversation.title, 'How do I paginate a MySQL');

  assert.deepEqual(
    memory.listConversations(PROJECT_A).map((c) => [c.id, c.message_count]),
    [[id, 3]],
  );
  assert.deepEqual(
    memory.getRecent(PROJECT_A, 2).map((m) => m.content),
    ['Use LIMIT and OFFSET…', 'something else entirely now'],
  );
  assert.equal(memory.getConversation(9999), null);
  assert.ok(fs.existsSync(file), 'database file created');
  assert.deepEqual(warnings, []);
});

test('memory: data persists across Memory instances (separate runs)', (t) => {
  const { memory, file } = tempMemory(t);
  const id = memory.newConversation(PROJECT_A);
  memory.addMessage(id, 'user', 'remember me');
  memory.saveFact(PROJECT_A, 'stack', 'Node + MySQL');
  memory.close();

  const again = new Memory({ file, onWarn: () => {} });
  try {
    assert.equal(again.latestConversation(PROJECT_A).id, id);
    assert.equal(again.getFacts(PROJECT_A)[0].value, 'Node + MySQL');
  } finally {
    again.close(); // before the temp folder is removed
  }
});

test('memory: facts are upserted per project and isolated between projects', (t) => {
  const { memory } = tempMemory(t);
  memory.saveFact(PROJECT_A, 'stack', 'Node + MySQL');
  memory.saveFact(PROJECT_A, 'stack', 'Node 22 + MySQL 8'); // same key replaces
  memory.saveFact(PROJECT_A, 'repo', 'Vaanijya');
  memory.saveFact(PROJECT_B, 'stack', 'Python');

  assert.deepEqual(
    memory.getFacts(PROJECT_A).map((f) => [f.key, f.value]),
    [
      ['repo', 'Vaanijya'],
      ['stack', 'Node 22 + MySQL 8'],
    ],
  );
  assert.deepEqual(
    memory.getFacts(PROJECT_B).map((f) => f.value),
    ['Python'],
  );
});

test('memory: conversations are isolated per project', (t) => {
  const { memory } = tempMemory(t);
  const a = memory.newConversation(PROJECT_A);
  memory.addMessage(a, 'user', 'project A question');
  const b = memory.newConversation(PROJECT_B);
  memory.addMessage(b, 'user', 'project B question');

  assert.equal(memory.latestConversation(PROJECT_A).id, a);
  assert.equal(memory.latestConversation(PROJECT_B).id, b);
  assert.deepEqual(
    memory.listConversations(PROJECT_A).map((c) => c.id),
    [a],
  );
  assert.equal(memory.search(PROJECT_A, 'project B').messages.length, 0);
  assert.equal(memory.latestConversation(GLOBAL_PROJECT), null);
});

test('memory: empty conversations are not listed', (t) => {
  const { memory } = tempMemory(t);
  memory.newConversation(PROJECT_A);
  assert.deepEqual(memory.listConversations(PROJECT_A), []);
});

test('memory: search finds messages and facts, treating % and _ literally', (t) => {
  const { memory } = tempMemory(t);
  const id = memory.newConversation(PROJECT_A);
  memory.addMessage(id, 'user', 'The pool connection keeps timing out');
  memory.addMessage(id, 'assistant', 'Coverage is at 100% now');
  memory.saveFact(PROJECT_A, 'db', 'MySQL connection pool of 10');

  const result = memory.search(PROJECT_A, 'connection');
  assert.deepEqual(
    result.messages.map((m) => m.content),
    ['The pool connection keeps timing out'],
  );
  assert.deepEqual(
    result.facts.map((f) => f.key),
    ['db'],
  );
  assert.equal(memory.search(PROJECT_A, '100%').messages.length, 1);
  assert.equal(memory.search(PROJECT_A, '%').messages.length, 1); // only the literal "%"
  assert.deepEqual(memory.search(PROJECT_A, '   '), { messages: [], facts: [] });
});

test('memory: a locked database falls back to in-memory without throwing', (t) => {
  const { memory, file, warnings } = tempMemory(t, { busyTimeout: 50 });
  memory.saveFact(PROJECT_A, 'before', 'lock'); // creates the file

  // Another process holds the write lock.
  const other = new Database(file);
  other.exec('BEGIN EXCLUSIVE');
  const release = () => {
    if (other.inTransaction) other.exec('ROLLBACK');
    other.close();
  };

  let id;
  assert.doesNotThrow(() => {
    id = memory.newConversation(PROJECT_A);
    memory.addMessage(id, 'user', 'still works');
  });
  assert.equal(memory.temporary, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /memory database unavailable \(SQLITE_BUSY\)/);
  // Keeps working (in memory) for the rest of the run.
  assert.equal(memory.getConversation(id).messages[0].content, 'still works');
  memory.saveFact(PROJECT_A, 'k', 'v');
  assert.equal(warnings.length, 1, 'warns only once');
  release();
});

test('memory: an unopenable path falls back to in-memory without throwing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elliot-mem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'not-a-folder');
  fs.writeFileSync(blocker, 'x'); // a file where the DB folder should be
  const warnings = [];
  const memory = new Memory({ file: path.join(blocker, 'elliot.db'), onWarn: (w) => warnings.push(w) });
  t.after(() => memory.close());

  assert.doesNotThrow(() => memory.saveFact(PROJECT_A, 'k', 'v'));
  assert.equal(memory.temporary, true);
  assert.equal(warnings.length, 1);
  assert.equal(memory.getFacts(PROJECT_A)[0].value, 'v');
});

test('session: messages are saved, and continue seeds history in a new session', async (t) => {
  const { memory } = tempMemory(t);
  const cwd = 'D:\\projects\\vaanijya';
  const first = new Session({ cwd, memory, continue: true, stream: fakeStream() });
  assert.equal(first.conversationId, null, 'nothing to continue yet');
  await drain(first.send('How do I hash passwords in Node?'));
  await drain(first.send('and verify them?'));
  assert.equal(typeof first.conversationId, 'number');

  const saved = memory.getConversation(first.conversationId);
  assert.equal(saved.messages.length, 4);
  assert.equal(saved.conversation.title, 'How do I hash passwords in');
  assert.equal(saved.messages[1].model, first.model);

  // "Next run": a new Session continues where we left off.
  const second = new Session({ cwd, memory, continue: true, stream: fakeStream() });
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(second.title, 'How do I hash passwords in');
  assert.deepEqual(
    second.history.map((m) => m.content.slice(0, 20)),
    ['How do I hash passwo', 'Sure.\n```js\nok();\n``', 'and verify them?', 'Sure.\n```js\nok();\n``'],
  );

  // --new: starts fresh.
  const fresh = new Session({ cwd, memory, continue: false, stream: fakeStream() });
  assert.equal(fresh.conversationId, null);
  assert.deepEqual(fresh.history, []);
});

test('session: continue seeds at most 10 messages within a size budget', (t) => {
  const { memory } = tempMemory(t);
  const project = projectFor('D:\\projects\\big');
  const id = memory.newConversation(project);
  for (let i = 0; i < 15; i++) {
    memory.addMessage(id, 'user', `question ${i}`);
    memory.addMessage(id, 'assistant', i === 14 ? 'x'.repeat(10_000) : `answer ${i}`);
  }
  const session = new Session({ cwd: 'D:\\projects\\big', memory, continue: true });
  assert.ok(session.history.length <= 10);
  assert.equal(session.history[0].role, 'user');
  const total = session.history.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= 6_000, `seeded ${total} chars`);
  assert.match(session.history.at(-1).content, /\[… trimmed …\]$/);
});

test('session: resume by conversation id; unknown id throws', (t) => {
  const { memory } = tempMemory(t);
  const project = projectFor('D:\\projects\\vaanijya');
  const old = memory.newConversation(project);
  memory.addMessage(old, 'user', 'old topic');
  const newer = memory.newConversation(project);
  memory.addMessage(newer, 'user', 'new topic');

  const session = new Session({ cwd: 'D:\\projects\\vaanijya', memory, conversationId: old });
  assert.equal(session.conversationId, old);
  assert.deepEqual(
    session.history.map((m) => m.content),
    ['old topic'],
  );
  assert.throws(() => new Session({ memory, conversationId: 424242 }), /conversation 424242 not found/);
});

test('session: project facts appear in the system prompt and refresh after remember', (t) => {
  const { memory } = tempMemory(t);
  const cwd = 'D:\\projects\\vaanijya';
  const project = projectFor(cwd);
  memory.saveFact(project, 'stack', 'Node + MySQL');
  memory.saveFact(project, 'this repo', 'Vaanijya');

  const session = new Session({ cwd, memory });
  assert.match(session.system.content, /Project context/);
  assert.match(session.system.content, /- stack: Node \+ MySQL/);
  assert.match(session.system.content, /- this repo: Vaanijya/);

  memory.saveFact(project, 'db', 'MySQL 8');
  assert.doesNotMatch(session.system.content, /MySQL 8/);
  session.refreshFacts();
  assert.match(session.system.content, /- db: MySQL 8/);

  // Without facts there is no context block at all.
  const other = new Session({ cwd: 'D:\\projects\\empty', memory });
  assert.doesNotMatch(other.system.content, /Project context/);
});

test('helpers: projectFor, makeTitle, parseFact', () => {
  assert.equal(projectFor(os.homedir()), GLOBAL_PROJECT);
  assert.equal(projectFor(path.parse(process.cwd()).root), GLOBAL_PROJECT);
  if (process.platform === 'win32') assert.equal(projectFor('D:\\Projects\\App'), projectFor('d:\\projects\\app'));
  assert.equal(makeTitle('  one two\nthree four five six seven  '), 'one two three four five six');
  assert.deepEqual(parseFact('stack: Node + MySQL'), { key: 'stack', value: 'Node + MySQL' });
  assert.deepEqual(parseFact('url: http://localhost:3000'), { key: 'url', value: 'http://localhost:3000' });
  assert.equal(parseFact('no colon here'), null);
  assert.equal(parseFact('key:   '), null);
});
