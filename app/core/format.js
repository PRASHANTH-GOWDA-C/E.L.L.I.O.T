// Post-processing for model replies.
//
// Small models sometimes put the "Not checked: …" line inside the code block.
// NotCheckedFixer moves any such line to just after the block. It works on a
// stream: push() returns the text that is safe to show now, so replies still
// appear live; only lines that might turn out to be a "Not checked:" line (or
// a closing fence) inside a code block are briefly held back.

const FENCE = '```';
const COMMENT_PREFIX = /^(?:\/\/|#|--)\s*/;

/** Text after leading whitespace and a line-comment marker. */
function stripComment(line) {
  return line.trimStart().replace(COMMENT_PREFIX, '');
}

function isNotCheckedLine(line) {
  return /^[*_]*not checked\b/i.test(stripComment(line));
}

/** Could this unfinished line (inside a code block) still be one we'd hold? */
function mightBeHeld(partial) {
  const trimmed = partial.trim();
  if (trimmed === '') return true;
  if (FENCE.startsWith(trimmed) || trimmed.startsWith(FENCE)) return true;
  if (['/', '-'].includes(trimmed)) return true; // start of "//" or "--"
  const text = stripComment(partial).replace(/^[*_]+/, '').toLowerCase();
  return 'not checked'.startsWith(text) || text.startsWith('not checked');
}

export class NotCheckedFixer {
  #inFence = false;
  #line = ''; // current, unfinished line
  #lineEmitted = 0; // how much of #line was already returned
  #held = []; // "Not checked" lines found in the current code block
  #blankLines = 0; // blank lines inside the block, held until we know what follows

  /** Feeds a chunk; returns text that can be displayed now. */
  push(chunk) {
    let out = '';
    const parts = chunk.split('\n');
    for (let i = 0; i < parts.length; i++) {
      this.#line += parts[i];
      if (i < parts.length - 1) {
        const text = this.#finishLine();
        if (text !== null) out += `${text}\n`;
      }
    }
    return out + this.#flushPartial();
  }

  /** Call when the reply has ended; returns any remaining text. */
  end() {
    let out = '';
    let lineOpen = false; // last shown text doesn't end with "\n"
    if (this.#line) {
      const text = this.#finishLine();
      if (text !== null) {
        out += text;
        lineOpen = true;
      }
    }

    if (this.#held.length > 0) {
      // Code block was never closed: close it, then add the held lines.
      out += `${lineOpen ? '\n' : ''}${FENCE}\n\n${this.#held.join('\n')}`;
    } else if (this.#blankLines > 0) {
      out += '\n'.repeat(this.#blankLines);
    }
    this.#held = [];
    this.#blankLines = 0;
    this.#inFence = false;
    return out;
  }

  // Returns the start of an unfinished line unless it might be one we'd hold.
  #flushPartial() {
    if (!this.#line) return '';
    if (this.#lineEmitted === 0 && this.#inFence) {
      if (mightBeHeld(this.#line)) return '';
      const out = this.#takeBlankLines() + this.#line;
      this.#lineEmitted = this.#line.length;
      return out;
    }
    const out = this.#line.slice(this.#lineEmitted);
    this.#lineEmitted = this.#line.length;
    return out;
  }

  // Completes the current line. Returns its text (without "\n"), or null if held.
  #finishLine() {
    const line = this.#line;
    const emitted = this.#lineEmitted;
    this.#line = '';
    this.#lineEmitted = 0;
    const isFence = line.trim().startsWith(FENCE);

    if (!this.#inFence) {
      if (isFence) this.#inFence = true;
      return line.slice(emitted);
    }
    if (emitted > 0) return line.slice(emitted); // already partly shown: a normal code line

    if (isFence) {
      this.#inFence = false;
      if (this.#held.length > 0) {
        // Close the block (dropping trailing blank lines), then the moved lines.
        const moved = this.#held.join('\n');
        this.#held = [];
        this.#blankLines = 0;
        return `${line}\n\n${moved}`;
      }
      return this.#takeBlankLines() + line;
    }
    if (line.trim() === '') {
      this.#blankLines++;
      return null;
    }
    if (isNotCheckedLine(line)) {
      this.#held.push(stripComment(line).trim());
      return null;
    }
    return this.#takeBlankLines() + line;
  }

  #takeBlankLines() {
    const out = '\n'.repeat(this.#blankLines);
    this.#blankLines = 0;
    return out;
  }
}

/** Whole-text version of NotCheckedFixer. */
export function fixNotChecked(text) {
  const fixer = new NotCheckedFixer();
  return fixer.push(text) + fixer.end();
}

// ---- Memory listings (shared by the CLI and the full-screen UI) ----------------

/** ISO timestamp → "2026-11-15 17:42" in local time. */
export function formatDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Table of conversations (from Memory.listConversations). Marks `currentId` with "*". */
export function formatHistory(conversations, currentId = null) {
  const header = `${'ID'.padStart(5)}  ${'LAST ACTIVE'.padEnd(16)}  ${'MSGS'.padStart(4)}  TITLE`;
  const rows = conversations.map((c) => {
    const id = `${c.id === currentId ? '*' : ''}${c.id}`.padStart(5);
    return `${id}  ${formatDate(c.updated_at)}  ${String(c.message_count).padStart(4)}  ${c.title ?? '(untitled)'}`;
  });
  return [header, ...rows].join('\n');
}

/** "key  value" lines for facts (from Memory.getFacts). */
export function formatFacts(facts) {
  const width = Math.max(...facts.map((f) => f.key.length));
  return facts.map((f) => `  ${f.key.padEnd(width)}  ${f.value}`).join('\n');
}
