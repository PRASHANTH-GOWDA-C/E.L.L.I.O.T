// Slash-command and key reference for the full-screen UI.

export const ROLES = ['coder', 'fast', 'reason'];

// Listed in the README; not built yet.
export const PLANNED_COMMANDS = new Set(['review', 'audit', 'debt']);

export const HELP_TEXT = `Commands
  /help                      this list
  /new                       start a new conversation (/clear does the same)
  /history                   this project's saved conversations
  /remember key: value       save a note about this project
  /facts                     list saved notes
  /edit <instruction>        propose a file change; shows a diff, writes only on y
  /model coder|fast|reason   use this model for the next messages (manual)
  /auto                      pick the model automatically per message
  /voice plain|alderson      change how Elliot talks
  /models                    model check report
  /quit                      quit

Keys
  INSERT   Enter send · Esc stop reply / go to NORMAL · PgUp/PgDn scroll
  NORMAL   j/k or ↑/↓ scroll · g/G top/bottom · i insert · :q quit
  Anywhere Ctrl+C quits`;
