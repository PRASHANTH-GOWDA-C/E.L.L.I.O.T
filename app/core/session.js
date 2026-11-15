import config from './config.js';
import { chatStream } from './llm.js';
import { buildSystemPrompt } from './persona.js';
import { projectFor } from './memory.js';

const MAX_HISTORY_MESSAGES = 20;
// Seeding from memory: enough to "continue where we left off" without filling
// a small (4096-token) context window with old messages.
const SEED_MESSAGES = 10;
const SEED_MAX_CHARS = 6_000;
const SEED_MESSAGE_MAX_CHARS = 2_000;

/** Last messages that fit the seed budget, starting with a user message. */
function seedHistory(rows) {
  const seeded = [];
  let budget = SEED_MAX_CHARS;
  for (const row of rows.slice(-SEED_MESSAGES).reverse()) {
    const content =
      row.content.length > SEED_MESSAGE_MAX_CHARS
        ? `${row.content.slice(0, SEED_MESSAGE_MAX_CHARS)}\n[… trimmed …]`
        : row.content;
    if (content.length > budget) break;
    budget -= content.length;
    seeded.unshift({ role: row.role, content });
  }
  while (seeded[0]?.role === 'assistant') seeded.shift();
  return seeded;
}

/** A conversation with Elliot: system prompt + rolling user/assistant history. */
export class Session {
  #cwd;
  #voice;
  #facts = [];
  #stream;

  /**
   * @param {{
   *   model?: string, cwd?: string, voice?: string, maxHistory?: number,
   *   memory?: import('./memory.js').Memory | null,  // null = don't remember anything
   *   project?: string,         // memory key, defaults to projectFor(cwd)
   *   continue?: boolean,       // seed history from this project's latest conversation
   *   conversationId?: number,  // resume this conversation instead
   *   stream?: typeof chatStream,
   * }} [opts]
   */
  constructor({
    model = config.models.coder.name,
    cwd = process.cwd(),
    voice = config.voice,
    maxHistory = MAX_HISTORY_MESSAGES,
    memory = null,
    project = projectFor(cwd),
    continue: continueLatest = false,
    conversationId = null,
    stream = chatStream,
  } = {}) {
    this.model = model;
    this.maxHistory = maxHistory;
    this.memory = memory;
    this.project = project;
    this.#cwd = cwd;
    this.#stream = stream;
    /** @type {number|null} set when the first message is saved, or when continuing */
    this.conversationId = null;
    /** Title of the continued conversation, if any. */
    this.title = null;
    /** @type {{ role: 'user'|'assistant', content: string }[]} */
    this.history = [];

    if (memory) {
      this.#facts = memory.getFacts(project);
      const conversation = conversationId
        ? memory.getConversation(conversationId)?.conversation
        : continueLatest
          ? memory.latestConversation(project)
          : null;
      if (conversationId && !conversation) throw new RangeError(`conversation ${conversationId} not found`);
      if (conversation) {
        this.conversationId = conversation.id;
        this.title = conversation.title;
        this.history = seedHistory(memory.getMessages(conversation.id, SEED_MESSAGES));
      }
    }
    this.voice = voice; // builds the system prompt
  }

  get voice() {
    return this.#voice;
  }

  /** Changing the voice rebuilds the system prompt; history is kept. */
  set voice(voice) {
    this.system = { role: 'system', content: buildSystemPrompt({ cwd: this.#cwd, voice, facts: this.#facts }) };
    this.#voice = voice;
  }

  /** Reloads saved facts into the system prompt (after `remember`). */
  refreshFacts() {
    if (!this.memory) return;
    this.#facts = this.memory.getFacts(this.project);
    this.voice = this.#voice;
  }

  /** Full message list as sent to the model. */
  get messages() {
    return [this.system, ...this.history];
  }

  /**
   * Sends a user message and streams the reply. Yields text chunks and returns
   * the stream stats. History (and memory) are only updated when the reply
   * completes, so a cancelled or failed reply leaves the conversation unchanged.
   * @param {string} text
   * @param {{ signal?: AbortSignal, title?: string }} [opts] title: text to title a new conversation from
   * @returns {AsyncGenerator<string, import('./llm.js').StreamStats, void>}
   */
  async *send(text, { signal, title = text } = {}) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('message must be a non-empty string');
    }

    const userMessage = { role: 'user', content: text };
    const model = this.model;
    const stream = this.#stream({ model, messages: [...this.messages, userMessage], signal });

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
    this.#remember(text, reply, model, title);
    return result.value;
  }

  #remember(text, reply, model, title) {
    if (!this.memory) return;
    this.conversationId ??= this.memory.newConversation(this.project);
    if (this.conversationId === null) return; // memory unavailable; already warned
    this.memory.addMessage(this.conversationId, 'user', text, null, { titleText: title });
    this.memory.addMessage(this.conversationId, 'assistant', reply, model);
  }
}
