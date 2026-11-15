import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel } from '../app/core/router.js';

// Explicit model names so the tests don't depend on .env.
const models = {
  coder: { name: 'qwen2.5-coder:7b' },
  fast: { name: 'qwen2.5-coder:1.5b' },
  reason: { name: 'deepseek-r1:8b' },
};
const ALL = ['qwen2.5-coder:7b', 'qwen2.5-coder:1.5b', 'deepseek-r1:8b'];
const CODER_ONLY = ['qwen2.5-coder:7b'];

const route = (text, opts = {}) => chooseModel(text, { installed: ALL, models, ...opts });

const STACK = `TypeError: Cannot read properties of undefined (reading 'map')
    at renderList (/app/src/list.js:12:18)
    at main (/app/src/index.js:5:3)`;

const cases = [
  // [message, expected role with everything installed, expected role with coder only]
  ['hi', 'fast', 'coder'],
  ['thanks!', 'fast', 'coder'],
  ['yes', 'fast', 'coder'],
  ['what time is it?', 'fast', 'coder'],
  ['why is this O(n^2)?', 'reason', 'coder'],
  ['help me debug this race condition in my queue', 'reason', 'coder'],
  ['prove that this greedy choice is optimal for the interval problem', 'reason', 'coder'],
  [STACK, 'reason', 'coder'],
  ['Write a JS function that reverses a string', 'coder', 'coder'],
  ['How do I connect to MySQL from Node with a connection pool?', 'coder', 'coder'],
  ['fix `arr.map(x => x*2)`', 'coder', 'coder'], // short, but contains code
];

for (const [text, withAll, coderOnly] of cases) {
  const label = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  test(`router: "${label}" → ${withAll} (all installed)`, () => {
    assert.equal(route(text).role, withAll);
  });
  test(`router: "${label}" → ${coderOnly} (only coder installed)`, () => {
    assert.equal(route(text, { installed: CODER_ONLY }).role, coderOnly);
  });
}

test('router returns the model name and a short reason', () => {
  assert.deepEqual(route('why is this O(n^2)?'), { role: 'reason', model: 'deepseek-r1:8b', reason: 'reasoning: "why"' });
  assert.deepEqual(route('hi'), { role: 'fast', model: 'qwen2.5-coder:1.5b', reason: 'short message' });
  assert.deepEqual(route('Write a JS function that reverses a string'), {
    role: 'coder',
    model: 'qwen2.5-coder:7b',
    reason: 'coding question',
  });
});

test('router explains a fallback when the reason model is missing', () => {
  const choice = route('why is this O(n^2)?', { installed: CODER_ONLY });
  assert.equal(choice.role, 'coder');
  assert.match(choice.reason, /deepseek-r1:8b not installed/);
});

test('router treats unknown install state (Ollama unreachable) as coder only', () => {
  assert.equal(route('hi', { installed: null }).role, 'coder');
  assert.equal(route('why?', { installed: null }).role, 'coder');
});

test('router sends a long error paste to reason', () => {
  const log = `npm ERR! code ELIFECYCLE\n${'build output line\n'.repeat(100)}Error: build failed`;
  assert.equal(route(log).role, 'reason');
  assert.equal(route(log).reason, 'reasoning: long error output');
});

test('router keeps short follow-ups to a code answer on the coder', () => {
  const history = [
    { role: 'user', content: 'reverse a string in JS' },
    { role: 'assistant', content: '```js\nconst r = (s) => [...s].reverse().join("");\n```' },
  ];
  assert.deepEqual(route('and in Python?', { history }), {
    role: 'coder',
    model: 'qwen2.5-coder:7b',
    reason: 'follow-up on code',
  });
});

test('router handles empty input', () => {
  assert.equal(route('').role, 'coder');
});
