import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_SCHEMA, parseLooseJson, parseToolCalls, runAgent } from '../app/core/agent.js';
import { LlmError } from '../app/core/llm.js';
import { createFileTools } from '../app/core/tools/files.js';

const ORIGINAL = 'export function greet(name) {\n  return `Hi ${name}`;\n}\n';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elliot-agent-'));
  fs.writeFileSync(path.join(root, 'greet.js'), ORIGINAL);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, files: createFileTools(root) };
}

/** Fake chatWithTools that replays scripted assistant messages and records requests. */
function scripted(...replies) {
  const calls = [];
  const fn = async ({ messages, tools }) => {
    calls.push({ messages: structuredClone(messages), tools });
    if (replies.length === 0) throw new Error('script ran out of replies');
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

const nativeCall = (name, args, id = 'c1') => ({
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }],
});

const unchanged = (root) => assert.equal(fs.readFileSync(path.join(root, 'greet.js'), 'utf8'), ORIGINAL, 'file must not be written');

test('agent: read_file then propose_edit returns a diff and writes nothing', async (t) => {
  const { root, files } = project(t);
  const chatFn = scripted(
    nativeCall('read_file', { path: 'greet.js' }),
    nativeCall('propose_edit', {
      path: 'greet.js',
      old_text: 'export function greet(name) {\n',
      new_text: "export function greet(name) {\n  if (typeof name !== 'string') throw new TypeError('name must be a string');\n",
    }),
  );
  const events = [];
  const result = await runAgent({ instruction: 'validate name in greet.js', files, chatFn, onEvent: (e) => events.push(e) });

  assert.equal(result.proposals.length, 1);
  assert.match(result.proposals[0].diff, /\+  if \(typeof name !== 'string'\)/);
  assert.deepEqual(events.map((e) => [e.name, e.ok]), [['read_file', true], ['propose_edit', true]]);
  unchanged(root);

  // The model got the file content back as a tool message.
  const second = chatFn.calls[1].messages;
  assert.equal(second.at(-1).role, 'tool');
  assert.match(second.at(-1).content, /Hi \$\{name\}/);
  // Only read/list/search/propose tools are offered — no write tool exists.
  assert.deepEqual(chatFn.calls[0].tools.map((t) => t.function.name), ['read_file', 'list_files', 'search_files', 'propose_edit']);
  assert.deepEqual(TOOL_SCHEMA.map((t) => t.function.name), ['read_file', 'list_files', 'search_files', 'propose_edit']);
});

test('agent: repairs slightly malformed tool-call JSON (trailing comma, single quotes)', async (t) => {
  const { files } = project(t);
  const chatFn = scripted(nativeCall('read_file', "{'path': 'greet.js',}"), { content: 'It greets by name.' });
  const events = [];
  const result = await runAgent({ instruction: 'what does greet.js do?', files, chatFn, onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => [e.name, e.ok]), [['read_file', true]]);
  assert.equal(result.answer, 'It greets by name.');
});

test('agent: hopeless tool-call JSON is reported back to the model, no crash', async (t) => {
  const { root, files } = project(t);
  const chatFn = scripted(nativeCall('read_file', '{path: greet.js <<<'), { content: 'Sorry, plain answer instead.' });
  const events = [];
  const result = await runAgent({ instruction: 'read greet.js', files, chatFn, onEvent: (e) => events.push(e) });
  assert.equal(events[0].ok, false);
  assert.match(events[0].error, /not valid JSON/);
  assert.match(chatFn.calls[1].messages.at(-1).content, /BAD_TOOL_CALL/);
  assert.equal(result.answer, 'Sorry, plain answer instead.');
  assert.deepEqual(result.proposals, []);
  unchanged(root);
});

test('agent: tool calls written as text (```json fence) are understood', async (t) => {
  const { files } = project(t);
  const chatFn = scripted(
    { content: 'Let me look.\n```json\n{"name": "read_file", "arguments": {"path": "greet.js"}}\n```' },
    { content: 'Done looking.' },
  );
  const events = [];
  await runAgent({ instruction: 'look at greet.js', files, chatFn, onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => [e.name, e.ok]), [['read_file', true]]);
  assert.match(chatFn.calls[1].messages.at(-1).content, /^Result of read_file:/);
});

test('agent: unknown tools and escape attempts return errors to the model', async (t) => {
  const { root, files } = project(t);
  const chatFn = scripted(
    nativeCall('delete_file', { path: 'greet.js' }),
    nativeCall('read_file', { path: '../../etc/passwd' }),
    nativeCall('propose_edit', { path: '../outside.js', content: 'x' }),
    { content: 'Cannot do that.' },
  );
  const events = [];
  const result = await runAgent({ instruction: 'do bad things', files, chatFn, onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => e.ok), [false, false, false]);
  assert.match(events[0].error, /unknown tool/);
  assert.match(events[1].error, /outside the project/);
  assert.equal(result.proposals.length, 0);
  unchanged(root);
  assert.equal(fs.existsSync(path.join(root, '..', 'outside.js')), false);
});

test('agent: a full-content rewrite of a file it never read is refused', async (t) => {
  const { root, files } = project(t);
  const chatFn = scripted(nativeCall('propose_edit', { path: 'greet.js', content: 'oops\n' }), { content: 'ok' });
  const events = [];
  const result = await runAgent({ instruction: 'rewrite greet.js', files, chatFn, onEvent: (e) => events.push(e) });
  assert.equal(events[0].ok, false);
  assert.match(events[0].error, /read_file on greet\.js before replacing/);
  assert.equal(result.proposals.length, 0);
  unchanged(root);
});

test('agent: old_text that is missing or ambiguous is rejected', async (t) => {
  const { files } = project(t);
  const chatFn = scripted(
    nativeCall('propose_edit', { path: 'greet.js', old_text: 'not in file', new_text: 'x' }),
    nativeCall('propose_edit', { path: 'greet.js', old_text: 'e', new_text: 'E' }),
    { content: 'giving up' },
  );
  const events = [];
  await runAgent({ instruction: 'edit', files, chatFn, onEvent: (e) => events.push(e) });
  assert.match(events[0].error, /not found/);
  assert.match(events[1].error, /appears \d+ times/);
});

test('agent: stops after max iterations', async (t) => {
  const { files } = project(t);
  const chatFn = scripted(...Array.from({ length: 3 }, (_, i) => nativeCall('list_files', {}, `c${i}`)));
  const result = await runAgent({ instruction: 'loop forever', files, chatFn, maxIterations: 3 });
  assert.match(result.answer, /Stopped after 3 tool steps/);
  assert.equal(chatFn.calls.length, 3);
});

test('agent: falls back to a plain answer when the model has no tool support', async (t) => {
  const { files } = project(t);
  const chatFn = scripted(new LlmError('TOOLS_UNSUPPORTED', 'no tools'));
  const plainChatFn = async () => 'Plain answer.';
  const result = await runAgent({ instruction: 'help', files, chatFn, plainChatFn });
  assert.deepEqual(result, { answer: 'Plain answer.', proposals: [], fallback: true });
});

test('agent: other model errors (e.g. Ollama offline) propagate', async (t) => {
  const { files } = project(t);
  const chatFn = scripted(new LlmError('OLLAMA_OFFLINE', 'Ollama is not running'));
  await assert.rejects(runAgent({ instruction: 'help', files, chatFn }), /Ollama is not running/);
});

test('parseLooseJson and parseToolCalls edge cases', () => {
  assert.deepEqual(parseLooseJson('{"a": 1,}'), { a: 1 });
  assert.deepEqual(parseLooseJson("{'a': 'it\\'s'}"), { a: "it's" });
  assert.deepEqual(parseLooseJson('noise {"a": True} noise'), { a: true });
  assert.equal(parseLooseJson('not json at all'), undefined);
  // JSON in an ordinary answer is not a tool call unless it names a real tool.
  assert.deepEqual(parseToolCalls({ content: '```json\n{"name": "my-app", "version": "1.0.0"}\n```' }).calls, []);
  assert.equal(parseToolCalls({ content: '<tool_call>{"name":"list_files","arguments":{}}</tool_call>' }).calls[0].name, 'list_files');
  assert.equal(parseToolCalls({ content: '{"function": {"name": "search_files", "parameters": {"query": "x"}}}' }).calls[0].args.query, 'x');
});

test('agent: pasted code instead of a tool call gets one reminder, then tools are used', async (t) => {
  const { root, files } = project(t);
  const chatFn = scripted(
    { content: 'Here:\n```js\nexport function greet(name) { /* … */ }\n```' },
    nativeCall('read_file', { path: 'greet.js' }),
    nativeCall('propose_edit', { path: 'greet.js', old_text: 'Hi', new_text: 'Hello' }),
  );
  const events = [];
  const result = await runAgent({ instruction: 'say Hello in greet.js', files, chatFn, onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => e.name), ['reminder', 'read_file', 'propose_edit']);
  assert.match(chatFn.calls[1].messages.at(-1).content, /do not paste code/i);
  assert.equal(result.proposals.length, 1);
  unchanged(root);
});

test('agent: the reminder is sent only once', async (t) => {
  const { files } = project(t);
  const code = { content: '```js\nx();\n```' };
  const chatFn = scripted(code, { ...code });
  const result = await runAgent({ instruction: 'edit', files, chatFn });
  assert.equal(chatFn.calls.length, 2);
  assert.equal(result.proposals.length, 0);
  assert.match(result.answer, /x\(\);/);
});

test('agent: system prompt is the tools variant (no code-answer examples)', async (t) => {
  const { files } = project(t);
  const chatFn = scripted({ content: 'ok' }, { content: 'ok' }); // second reply answers the reminder
  await runAgent({ instruction: 'hi', files, chatFn });
  const system = chatFn.calls[0].messages[0].content;
  assert.match(system, /you MUST call read_file first, then propose_edit/);
  assert.doesNotMatch(system, /^Example$/m);
  assert.doesNotMatch(system, /Answer format when your answer contains code/);
});

test('agent: the real qwen2.5-coder output with an extra closing brace is parsed', async (t) => {
  const { root, files } = project(t);
  // Verbatim shape of a reply seen from qwen2.5-coder:7b (note the "}}}").
  const realReply =
    '```json\n{"name": "propose_edit", "arguments": {"path": "greet.js", "new_text": "  return `Hello ${name}`;", "old_text": "  return `Hi ${name}`;"}}}\n```';
  const chatFn = scripted(nativeCall('read_file', { path: 'greet.js' }), { content: realReply });
  const result = await runAgent({ instruction: 'say Hello', files, chatFn });
  assert.equal(result.proposals.length, 1);
  assert.match(result.proposals[0].diff, /\+  return `Hello \$\{name\}`;/);
  assert.equal(result.answer, '', 'the raw tool-call JSON is not shown as the answer');
  unchanged(root);
});

test('agent: an unparseable text call naming a real tool is reported back, not ignored', async (t) => {
  const { files } = project(t);
  const chatFn = scripted({ content: '```json\n{"name": "read_file", "arguments": {path: <<<}\n```' }, { content: 'ok' });
  const events = [];
  await runAgent({ instruction: 'read', files, chatFn, onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => [e.name, e.ok]), [['read_file', false]]);
  assert.match(chatFn.calls[1].messages.at(-1).content, /BAD_TOOL_CALL/);
});

// ---- Syntax guard ------------------------------------------------------------------

test('syntax: checkSyntax reports broken JS and accepts ESM, CommonJS and non-JS files', async () => {
  const { checkSyntax } = await import('../app/core/tools/syntax.js');
  assert.equal(checkSyntax('a.js', 'export const x = 1;\n'), null);
  assert.equal(checkSyntax('a.js', 'module.exports = require("x");\n'), null);
  assert.equal(checkSyntax('a.cjs', 'module.exports = 1;\n'), null);
  assert.match(checkSyntax('a.js', 'export function f() {\n  return 1;\n'), /SyntaxError: Unexpected end of input \(line \d+\)/);
  assert.equal(checkSyntax('a.ts', 'let x: number = {'), null, 'TypeScript is not checked');
  assert.equal(checkSyntax('notes.md', '{{{'), null);
});

test('agent: an edit that breaks the syntax is refused and the model can retry', async (t) => {
  const { root, files } = project(t);
  const chatFn = scripted(
    nativeCall('read_file', { path: 'greet.js' }),
    // Loses the closing brace — what qwen2.5-coder:7b really did in the v1 end-to-end run.
    nativeCall('propose_edit', { path: 'greet.js', old_text: '  return `Hi ${name}`;\n}\n', new_text: '  return `Hello ${name}`;\n' }),
    nativeCall('propose_edit', { path: 'greet.js', old_text: '  return `Hi ${name}`;', new_text: '  return `Hello ${name}`;' }),
  );
  const events = [];
  const result = await runAgent({ instruction: 'say Hello', files, chatFn, onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => [e.name, e.ok]), [['read_file', true], ['propose_edit', false], ['propose_edit', true]]);
  assert.match(events[1].error, /would break greet\.js: SyntaxError/);
  assert.equal(result.proposals.length, 1);
  assert.match(result.proposals[0].newContent, /Hello \$\{name\}`;\n\}\n$/);
  unchanged(root);
});

test('agent: the syntax guard does not block edits to a file that was already broken', async (t) => {
  const { root, files } = project(t);
  fs.writeFileSync(path.join(root, 'greet.js'), 'export function greet(name) {\n  return `Hi ${name}`;\n'); // already broken
  const chatFn = scripted(nativeCall('propose_edit', { path: 'greet.js', old_text: 'Hi', new_text: 'Hello' }));
  const result = await runAgent({ instruction: 'say Hello', files, chatFn });
  assert.equal(result.proposals.length, 1);
});

test('agent: a bare tool call after prose is understood (real qwen2.5-coder reply)', async (t) => {
  const { files } = project(t);
  // Verbatim shape from the v1 end-to-end run.
  const prose = 'I will first read the file and then propose an edit.\n\n{"name": "read_file", "arguments": {"path": "greet.js"}}';
  const chatFn = scripted(
    { content: prose },
    { content: 'Here is the fix.\n{"name": "propose_edit", "arguments": {"path": "greet.js", "old_text": "Hi", "new_text": "Hello"}}' },
  );
  const events = [];
  const result = await runAgent({ instruction: 'say Hello', files, chatFn, onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => [e.name, e.ok]), [['read_file', true], ['propose_edit', true]]);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.answer, 'Here is the fix.', 'the JSON is removed from the shown answer');
});

test('agent: prose that merely mentions JSON with an unknown "name" is not a tool call', () => {
  const { calls } = parseToolCalls({ content: 'Your package.json has {"name": "shop", "type": "module"} — fine.' });
  assert.deepEqual(calls, []);
});

test('agent: answering without using any tool gets one reminder (real qwen2.5-coder reply)', async (t) => {
  const { files } = project(t);
  const chatFn = scripted(
    { content: 'Please provide the file contents of `greet.js` so I can analyze it.' },
    nativeCall('read_file', { path: 'greet.js' }),
    nativeCall('propose_edit', { path: 'greet.js', old_text: 'Hi', new_text: 'Hello' }),
  );
  const events = [];
  const result = await runAgent({ instruction: 'say Hello in greet.js', files, chatFn, onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => e.name), ['reminder', 'read_file', 'propose_edit']);
  assert.match(chatFn.calls[1].messages.at(-1).content, /read the project files yourself/);
  assert.equal(result.proposals.length, 1);
});

test('agent: a stray brace after a bare tool call is not shown as the answer', async (t) => {
  const { files } = project(t);
  const chatFn = scripted(
    nativeCall('read_file', { path: 'greet.js' }),
    { content: '{"name": "propose_edit", "arguments": {"path": "greet.js", "old_text": "Hi", "new_text": "Hello"}}\n}' },
  );
  const result = await runAgent({ instruction: 'say Hello', files, chatFn });
  assert.equal(result.proposals.length, 1);
  assert.equal(result.answer, '');
});
