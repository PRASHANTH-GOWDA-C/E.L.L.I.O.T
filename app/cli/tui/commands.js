// Slash-command and key reference for the full-screen UI.

export const ROLES = ['coder', 'fast', 'reason'];

export const HELP_TEXT = `Commands
  /help                      this list
  /new                       start a new conversation (/clear does the same)
  /history                   this project's saved conversations
  /remember key: value       save a note about this project
  /facts                     list saved notes
  /edit <instruction>        propose a file change; shows a diff, writes only on y
  /review [target]           review uncommitted | staged | branch | <file>
  /audit                     review the most important files, worst first
  /debt [word]               list "shortcut:" comments to pay back
  /model coder|fast|reason   use this model for the next messages (manual)
  /auto                      pick the model automatically per message
  /voice plain|alderson      change how Elliot talks
  /models                    model check report
  /quit                      quit

Keys
  INSERT   Enter send · Esc stop reply / go to NORMAL · PgUp/PgDn scroll
  NORMAL   j/k or ↑/↓ scroll · g/G top/bottom · i insert · :q quit
  Anywhere Ctrl+C quits`;
