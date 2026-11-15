import config from './config.js';
import { chatStream } from './llm.js';
import { buildSystemPrompt } from './persona.js';

const MAX_HISTORY_MESSAGES = 20;

/** A conversation with Elliot: system prompt + rolling user/assistant history. */
export class Session {
  /**
   * @param {{ model?: string, cwd?: string, maxHistory?: number }} [opts]
   */
  constructor({ model = config.models.coder.name, cwd = process.cwd(), maxHistory = MAX_HISTORY_MESSAGES } = {}) {
    this.model = model;
    this.maxHistory = maxHistory;
    this.system = { role: 'system', content: buildSystemPrompt({ cwd }) };
    /** @type {{ role: 'user'|'assistant', content: string }[]} */
    this.history = [];
  }

  /** Full message list as sent to the model. */
  get messages() {
    return [this.system, ...this.history];
  }

  /**
   * Sends a user message and streams the reply. Yields text chunks and returns
   * the stream stats. History is only updated when the reply completes, so a
   * cancelled or failed reply leaves the conversation unchanged.
   * @param {string} text
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {AsyncGenerator<string, import('./llm.js').StreamStats, void>}
   */
  async *send(text, { signal } = {}) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('message must be a non-empty string');
    }

    const userMessage = { role: 'user', content: text };
    const stream = chatStream({ model: this.model, messages: [...this.messages, userMessage], signal });

    let reply = '';
    let result;
    while (!(result = await stream.next()).done) {
      reply += result.value;
      yield result.value;
    }

    this.history.push(userMessage, { role: 'assistant', content: reply });
    // Drop the oldest messages; history grows in user/assistant pairs, so an
    // even limit keeps it starting with a user message.
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    return result.value;
  }
}
