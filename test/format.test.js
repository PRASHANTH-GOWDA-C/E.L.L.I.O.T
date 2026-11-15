import test from 'node:test';
import assert from 'node:assert/strict';
import { NotCheckedFixer, fixNotChecked } from '../app/core/format.js';
import { parseBlocks } from '../app/cli/tui/blocks.js';

/** Feeds text one character at a time, like a slow stream. */
function streamed(text) {
  const fixer = new NotCheckedFixer();
  let out = '';
  for (const ch of text) out += fixer.push(ch);
  return out + fixer.end();
}

const cases = [
  {
    name: 'moves a "Not checked" line out of the code block (real model output)',
    input: "```javascript\nconst reverseString = (str) => str;\n\nNot checked: performance, edge cases.\n```",
    expected: "```javascript\nconst reverseString = (str) => str;\n```\n\nNot checked: performance, edge cases.",
  },
  {
    name: 'leaves a correctly placed line alone',
    input: 'Use this:\n```js\nconst x = 1;\n```\n\nNot checked: not executed.',
    expected: 'Use this:\n```js\nconst x = 1;\n```\n\nNot checked: not executed.',
  },
  {
    name: 'strips a comment marker from the moved line',
    input: '```js\nx();\n// Not checked: tests\n```',
    expected: '```js\nx();\n```\n\nNot checked: tests',
  },
  {
    name: 'closes an unclosed block before the moved line',
    input: '```js\nx();\nNot checked: tests',
    expected: '```js\nx();\n```\n\nNot checked: tests',
  },
  {
    name: 'keeps blank lines that are part of the code',
    input: '```js\na();\n\nb();\n```',
    expected: '```js\na();\n\nb();\n```',
  },
  {
    name: 'does not touch text without code blocks',
    input: 'Not checked: nothing here\nplain text',
    expected: 'Not checked: nothing here\nplain text',
  },
];

for (const { name, input, expected } of cases) {
  test(`fixNotChecked: ${name}`, () => {
    assert.equal(fixNotChecked(input), expected);
  });
  test(`NotCheckedFixer (char by char): ${name}`, () => {
    assert.equal(streamed(input), expected);
  });
}

test('NotCheckedFixer shows normal code lines before the line ends (live streaming)', () => {
  const fixer = new NotCheckedFixer();
  assert.equal(fixer.push('```js\n'), '```js\n');
  assert.equal(fixer.push('const value'), 'const value');
  assert.equal(fixer.push(' = 1;\n'), ' = 1;\n');
  assert.equal(fixer.push('Not che'), ''); // held: might be "Not checked"
});

test('parseBlocks splits text and code with language', () => {
  assert.deepEqual(parseBlocks('Intro\n```js\nconst x = 1;\n```\nOutro'), [
    { type: 'text', text: 'Intro' },
    { type: 'code', lang: 'js', code: 'const x = 1;' },
    { type: 'text', text: 'Outro' },
  ]);
});

test('parseBlocks treats an unclosed fence as code (streaming)', () => {
  assert.deepEqual(parseBlocks('```python\nprint(1)'), [{ type: 'code', lang: 'python', code: 'print(1)' }]);
});
