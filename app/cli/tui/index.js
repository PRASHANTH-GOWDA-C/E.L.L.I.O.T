import { render } from 'ink';
import { getMemory } from '../../core/memory.js';
import { html } from './html.js';
import { App } from './App.js';

/**
 * Opens the full-screen UI in the terminal's alternate screen (like vim) and
 * resolves when the user quits. The original screen is restored on exit.
 * @param {{ role?: string, voice: string, fresh?: boolean, conversationId?: number }} opts
 *   role undefined = automatic routing; fresh = don't continue the last chat
 */
export async function runTui({ role, voice, fresh = false, conversationId }) {
  const memory = getMemory();
  // Warnings must not be written to stderr while Ink owns the screen; App shows them.
  memory.onWarn = null;
  const instance = render(
    html`<${App} role=${role} voice=${voice} fresh=${fresh} conversationId=${conversationId} memory=${memory} />`,
    { alternateScreen: true },
  );
  await instance.waitUntilExit();
}
