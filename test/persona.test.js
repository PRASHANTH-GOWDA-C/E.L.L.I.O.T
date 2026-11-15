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

test('voices differ only in tone and the example intro', () => {
  const strip = (p) => p.replace(/Tone:[\s\S]*?\n\nExample/, 'Example').replace(/Elliot: .*\n/, '');
  assert.equal(strip(buildSystemPrompt({ cwd, voice: 'plain' })), strip(buildSystemPrompt({ cwd, voice: 'alderson' })));
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
