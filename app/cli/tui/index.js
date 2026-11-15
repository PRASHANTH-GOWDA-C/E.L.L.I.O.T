import { render } from 'ink';
import { html } from './html.js';
import { App } from './App.js';

/**
 * Opens the full-screen UI in the terminal's alternate screen (like vim) and
 * resolves when the user quits. The original screen is restored on exit.
 * @param {{ role?: string, voice: string }} opts role undefined = automatic routing
 */
export async function runTui({ role, voice }) {
  const instance = render(html`<${App} role=${role} voice=${voice} />`, { alternateScreen: true });
  await instance.waitUntilExit();
}
