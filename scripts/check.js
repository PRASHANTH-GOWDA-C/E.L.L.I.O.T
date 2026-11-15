// `npm run check`: reports Ollama status, required models and a live test reply.
import config from '../app/config.js';
import { chat, listModels, isModelInstalled, LlmError } from '../app/server/llm.js';

const TEST_PROMPT = 'Reply with exactly: Elliot online';

const line = (text = '') => console.log(text);

async function main() {
  line('E.L.L.I.O.T system check');
  line('========================');
  line(`Ollama URL: ${config.ollamaUrl}`);

  let installed;
  try {
    installed = await listModels();
    line('Ollama:     ✅ online');
  } catch (err) {
    line('Ollama:     ❌ offline');
    line(`            ${err.message}`);
    return 1;
  }

  line();
  line('Required models');
  line('---------------');
  const missing = new Set();
  const roleWidth = Math.max(...Object.keys(config.models).map((r) => r.length));
  for (const [role, { name, load }] of Object.entries(config.models)) {
    const ok = isModelInstalled(installed, name);
    if (!ok) missing.add(name);
    line(`${ok ? '✅' : '❌'} ${role.padEnd(roleWidth)}  ${name}  (${load})`);
  }

  if (missing.size > 0) {
    line();
    line('To install missing models:');
    for (const name of missing) line(`  ollama pull ${name}`);
  }

  line();
  line('Live test');
  line('---------');
  const coder = config.models.coder.name;
  if (!isModelInstalled(installed, coder)) {
    line(`⏭️  Skipped: coder model ${coder} is not installed.`);
    return 1;
  }

  line(`Asking ${coder}: "${TEST_PROMPT}" (first load can take a minute)...`);
  const started = performance.now();
  try {
    const reply = await chat({ model: coder, messages: [{ role: 'user', content: TEST_PROMPT }] });
    const ms = Math.round(performance.now() - started);
    line(`✅ Reply: ${reply.trim()}`);
    line(`   Time:  ${ms} ms`);
  } catch (err) {
    line(`❌ ${err instanceof LlmError ? err.message : err}`);
    return 1;
  }

  // Only always-loaded models are essential; on-demand ones are optional.
  const essentialMissing = Object.values(config.models).some((m) => m.load === 'always' && missing.has(m.name));
  return essentialMissing ? 1 : 0;
}

process.exitCode = await main();
