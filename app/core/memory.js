// Elliot's long-term memory: one SQLite file (memory/elliot.db).
//
// Every call is wrapped so a locked, read-only or missing database never
// crashes Elliot: on failure we warn once and continue with a temporary
// in-memory database for the rest of the run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from './config.js';

export const GLOBAL_PROJECT = '~';
const TITLE_WORDS = 6;
const TITLE_MAX_CHARS = 60;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY,
    project    TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    title      TEXT
  );
  CREATE INDEX IF NOT EXISTS conversations_project ON conversations (project, updated_at);

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    model           TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, id);

  CREATE TABLE IF NOT EXISTS facts (
    id         INTEGER PRIMARY KEY,
    project    TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project, key)
  );
`;

// Errors that mean "this database file can't be used right now".
const UNUSABLE = /^SQLITE_(BUSY|LOCKED|CANTOPEN|READONLY|IOERR|CORRUPT|NOTADB|FULL|PERM)/;

const now = () => new Date().toISOString();

/**
 * Memory key for a folder: its absolute path, or "~" for the home folder and
 * drive roots (chats that don't belong to a project).
 */
export function projectFor(cwd) {
  const resolved = path.resolve(cwd);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) return GLOBAL_PROJECT;
  // Windows paths are case-insensitive: "D:\App" and "d:\app" are one project.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** "First six words of the message" style title. */
export function makeTitle(text) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ').slice(0, TITLE_WORDS).join(' ');
  return words.length > TITLE_MAX_CHARS ? `${words.slice(0, TITLE_MAX_CHARS - 1)}…` : words;
}

/** Escapes LIKE wildcards so a search for "100%" means the literal text. */
const likePattern = (query) => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class Memory {
  #file;
  #busyTimeout;
  #db = null;
  #temporary = false;
  /** Set once when we fall back to in-memory storage. */
  warning = null;
  /** Called once with the warning text. */
  onWarn;

  /**
   * @param {{ file?: string, busyTimeout?: number, onWarn?: (msg: string) => void }} [opts]
   *   file: path to the SQLite file, or ':memory:'
   */
  constructor({
    file = config.paths.dbFile,
    busyTimeout = 2_000,
    onWarn = (msg) => process.stderr.write(`elliot: ${msg}\n`),
  } = {}) {
    this.#file = file;
    this.#busyTimeout = busyTimeout;
    this.onWarn = onWarn;
  }

  /** True when running on the temporary in-memory fallback. */
  get temporary() {
    return this.#temporary;
  }

  #open(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file, { timeout: this.#busyTimeout });
    if (file !== ':memory:') {
      db.pragma('journal_mode = WAL'); // readers don't block the writer
      db.pragma('synchronous = NORMAL'); // fewer fsyncs: kinder to USB drives
    }
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    return db;
  }

  #fallBack(err) {
    try {
      this.#db?.close();
    } catch {
      // already unusable
    }
    this.#db = this.#open(':memory:');
    this.#temporary = true;
    if (!this.warning) {
      this.warning = `memory database unavailable (${err.code ?? err.message}) — using temporary memory for this run`;
      this.onWarn?.(this.warning);
    }
  }

  /** Runs fn(db); on a database failure, switches to in-memory and retries once. */
  #run(fn, fallbackValue) {
    try {
      if (!this.#db) {
        try {
          this.#db = this.#open(this.#file);
        } catch (err) {
          this.#fallBack(err);
        }
      }
      try {
        return fn(this.#db);
      } catch (err) {
        if (this.#temporary || !(UNUSABLE.test(err.code ?? '') || err.code === 'ENOENT')) throw err;
        this.#fallBack(err);
        return fn(this.#db);
      }
    } catch (err) {
      // Never crash Elliot over memory.
      if (!this.warning) {
        this.warning = `memory error: ${err.message}`;
        this.onWarn?.(this.warning);
      }
      return fallbackValue;
    }
  }

  close() {
    try {
      this.#db?.close();
    } catch {
      // ignore
    }
    this.#db = null;
  }

  // ---- Conversations ------------------------------------------------------------

  /** @returns {number|null} new conversation id */
  newConversation(project) {
    return this.#run((db) => {
      const ts = now();
      return Number(
        db.prepare('INSERT INTO conversations (project, started_at, updated_at) VALUES (?, ?, ?)').run(project, ts, ts)
          .lastInsertRowid,
      );
    }, null);
  }

  /**
   * Saves a message, bumps the conversation's updated_at and, for the first
   * user message, sets the title from `titleText` (defaults to the content).
   * @returns {number|null} message id
   */
  addMessage(conversationId, role, content, model = null, { titleText = content } = {}) {
    return this.#run((db) => {
      const ts = now();
      const save = db.transaction(() => {
        const id = db
          .prepare('INSERT INTO messages (conversation_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(conversationId, role, content, model, ts).lastInsertRowid;
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conversationId);
        if (role === 'user') {
          db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL').run(
            makeTitle(titleText),
            conversationId,
          );
        }
        return Number(id);
      });
      return save();
    }, null);
  }

  /** Most recently updated conversation of a project, or null. */
  latestConversation(project) {
    return this.#run(
      (db) =>
        db
          .prepare('SELECT * FROM conversations WHERE project = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
          .get(project) ?? null,
      null,
    );
  }

  /** Last `limit` messages of a conversation, oldest first. */
  getMessages(conversationId, limit = 1_000) {
    return this.#run(
      (db) =>
        db
          .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
          .all(conversationId, limit)
          .reverse(),
      [],
    );
  }

  /** Last `limit` messages across all of a project's conversations, oldest first. */
  getRecent(project, limit = 10) {
    return this.#run(
      (db) =>
        db
          .prepare(
            `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
             WHERE c.project = ? ORDER BY m.id DESC LIMIT ?`,
          )
          .all(project, limit)
          .reverse(),
      [],
    );
  }

  /** A project's conversations with message counts, newest first. */
  listConversations(project, limit = 50) {
    return this.#run(
      (db) =>
        db
          .prepare(
            `SELECT c.*, COUNT(m.id) AS message_count
             FROM conversations c JOIN messages m ON m.conversation_id = c.id
             WHERE c.project = ? GROUP BY c.id ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
          )
          .all(project, limit),
      [],
    );
  }

  /** @returns {{ conversation: object, messages: object[] } | null} */
  getConversation(id) {
    return this.#run((db) => {
      const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
      if (!conversation) return null;
      return { conversation, messages: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(id) };
    }, null);
  }

  // ---- Facts --------------------------------------------------------------------

  /** Saves (or replaces) a fact. @returns {boolean} */
  saveFact(project, key, value) {
    return this.#run((db) => {
      db.prepare(
        `INSERT INTO facts (project, key, value, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
      ).run(project, key, value, now());
      return true;
    }, false);
  }

  getFacts(project) {
    return this.#run((db) => db.prepare('SELECT * FROM facts WHERE project = ? ORDER BY key').all(project), []);
  }

  // ---- Search -------------------------------------------------------------------

  /** Simple text search over a project's messages and facts (embeddings come later). */
  search(project, query, limit = 20) {
    const empty = { messages: [], facts: [] };
    if (!query?.trim()) return empty;
    const pattern = likePattern(query.trim());
    return this.#run(
      (db) => ({
        messages: db
          .prepare(
            `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
             WHERE c.project = ? AND m.content LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT ?`,
          )
          .all(project, pattern, limit),
        facts: db
          .prepare(`SELECT * FROM facts WHERE project = ? AND (key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')`)
          .all(project, pattern, pattern),
      }),
      empty,
    );
  }
}

/** Parses "key: value" for remember commands. @returns {{ key: string, value: string } | null} */
export function parseFact(text) {
  const raw = String(text);
  const colon = raw.indexOf(':');
  if (colon === -1) return null;
  const key = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  return key && value ? { key, value } : null;
}

let shared = null;
/** The process-wide Memory on memory/elliot.db (opened lazily on first use). */
export function getMemory() {
  shared ??= new Memory();
  return shared;
}
