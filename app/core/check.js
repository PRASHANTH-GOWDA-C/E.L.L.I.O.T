// System check report, shared by `npm run check` and `elliot models`.
import config from './config.js';
import { chat, listModels, isModelInstalled, LlmError } from './llm.js';

const TEST_PROMPT = 'Reply with exactly: Elliot online';

/**
 * Prints the report and returns an exit code: 0 if Ollama is online and every
 * always-loaded model is installed and answering, otherwise 1.
 * @param {{ print?: (text?: string) => void }} [opts]
 */
export async function runCheck({ print = (text = '') => console.log(text) } = {}) {
  print('E.L.L.I.O.T system check');
  print('========================');
  print(`Ollama URL: ${config.ollamaUrl}`);

  let installed;
  try {
    installed = await listModels();
    print('Ollama:     ✅ online');
  } catch (err) {
    print('Ollama:     ❌ offline');
    print(`            ${err.message}`);
    return 1;
  }

  print();
  print('Required models');
  print('---------------');
  const missing = new Set();
  const roleWidth = Math.max(...Object.keys(config.models).map((r) => r.length));
  for (const [role, { name, load }] of Object.entries(config.models)) {
    const ok = isModelInstalled(installed, name);
    if (!ok) missing.add(name);
    print(`${ok ? '✅' : '❌'} ${role.padEnd(roleWidth)}  ${name}  (${load})`);
  }

  if (missing.size > 0) {
    print();
    print('To install missing models:');
    for (const name of missing) print(`  ollama pull ${name}`);
  }

  print();
  print('Live test');
  print('---------');
  const coder = config.models.coder.name;
  if (!isModelInstalled(installed, coder)) {
    print(`⏭️  Skipped: coder model ${coder} is not installed.`);
    return 1;
  }

  print(`Asking ${coder}: "${TEST_PROMPT}" (first load can take a minute)...`);
  const started = performance.now();
  try {
    const reply = await chat({ model: coder, messages: [{ role: 'user', content: TEST_PROMPT }] });
    const ms = Math.round(performance.now() - started);
    print(`✅ Reply: ${reply.trim()}`);
    print(`   Time:  ${ms} ms`);
  } catch (err) {
    print(`❌ ${err instanceof LlmError ? err.message : err}`);
    return 1;
  }

  // Only always-loaded models are essential; on-demand ones are optional.
  const essentialMissing = Object.values(config.models).some((m) => m.load === 'always' && missing.has(m.name));
  return essentialMissing ? 1 : 0;
}
