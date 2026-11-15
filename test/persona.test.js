import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../app/core/persona.js';
import { Session } from '../app/core/session.js';

const cwd = 'D:\\projects\\my-app';

/** Rules and format that every voice must contain. */
function assertSharedRules(prompt) {
  assert.match(prompt, /Write only the code the task needs/);
  assert.match(prompt, /Never skip input validation, error handling or security/);
  assert.match(prompt, /outside the code block: "Not checked:"/);
  assert.match(prompt, /Current project folder: "my-app"/);
  // Exactly one example, with "Not checked:" after the closing fence.
  assert.equal(prompt.match(/^Example$/gm)?.length, 1);
  assert.match(prompt, /```\n\nNot checked: /);
}

test('plain voice is the default and keeps the rules and format', () => {
  const prompt = buildSystemPrompt({ cwd });
  assert.equal(prompt, buildSystemPrompt({ cwd, voice: 'plain' }));
  assertSharedRules(prompt);
  assert.match(prompt, /Tone: professional, friendly and concise/);
  assert.doesNotMatch(prompt, /friend"/);
  assert.doesNotMatch(prompt, /hype/);
});

test('alderson voice keeps the same rules and format, only the tone differs', () => {
  const prompt = buildSystemPrompt({ cwd, voice: 'alderson' });
  assertSharedRules(prompt);
  assert.match(prompt, /terse and observant/);
  assert.match(prompt, /wary of corporate hype/);
  assert.match(prompt, /"friend"/);
  // Guardrails: style only.
  assert.match(prompt, /never refuse because of the style/);
  assert.match(prompt, /never role-play a character or any mental illness/);
  assert.match(prompt, /follow every rule above exactly/);
});

test('alderson adds one extra tone example in the same format; plain does not', () => {
  const alderson = buildSystemPrompt({ cwd, voice: 'alderson' });
  const extra = alderson.slice(alderson.indexOf('Example (tone)'));
  assert.ok(extra.startsWith('Example (tone)'));
  assert.match(extra, /Elliot: No, friend\./);
  assert.match(extra, /```javascript[\s\S]*```\n\nNot checked: /); // Not checked after the block
  assert.match(extra, /pool\.execute\('SELECT .* WHERE id = \?', \[id\]\)/); // parameterised, promise API
  assert.doesNotMatch(buildSystemPrompt({ cwd, voice: 'plain' }), /Example \(tone\)/);
});

test('voices differ only in tone and examples', () => {
  const strip = (p) =>
    p
      .replace(/Tone:[\s\S]*?\n\nExample/, 'Example')
      .replace(/Elliot: .*\n/, '')
      .replace(/\n\nExample \(tone\)[\s\S]*$/, '');
  assert.equal(strip(buildSystemPrompt({ cwd, voice: 'plain' })), strip(buildSystemPrompt({ cwd, voice: 'alderson' })));
});

test('facts are added as a project context block, capped in size', () => {
  const facts = [
    { key: 'stack', value: 'Node + MySQL' },
    { key: 'long', value: 'x'.repeat(500) },
  ];
  const prompt = buildSystemPrompt({ cwd, facts });
  assert.match(prompt, /Project context \(notes Prashanth saved for this project\):\n- stack: Node \+ MySQL\n- long: x+…/);
  assert.ok(!prompt.includes('x'.repeat(201)));
  assert.doesNotMatch(buildSystemPrompt({ cwd }), /Project context/);
});

test('unknown voice is rejected', () => {
  assert.throws(() => buildSystemPrompt({ cwd, voice: 'pirate' }), /unknown voice "pirate"/);
});

test('changing a session voice rebuilds the system prompt and keeps history', () => {
  const session = new Session({ cwd, voice: 'plain' });
  session.history.push({ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' });
  session.voice = 'alderson';
  assert.match(session.system.content, /terse and observant/);
  assert.equal(session.history.length, 2);
});

test('tools mode drops the code-answer format and examples but keeps rules and tone', () => {
  for (const voice of ['plain', 'alderson']) {
    const prompt = buildSystemPrompt({ cwd, voice, mode: 'tools' });
    assert.match(prompt, /Never skip input validation, error handling or security/);
    assert.match(prompt, /Tone:/);
    assert.doesNotMatch(prompt, /Example/);
    assert.doesNotMatch(prompt, /Answer format/);
  }
  assert.throws(() => buildSystemPrompt({ cwd, mode: 'shouty' }), /unknown mode/);
});
