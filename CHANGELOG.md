# Changelog

All notable changes to Elliot are listed here. Versions follow [Semantic Versioning](https://semver.org).

## [0.1.0] — 2026-11-15 — Elliot v1

The first complete version: an offline coding companion in the terminal, running on local models through Ollama.

### Added
- **`elliot` CLI** with a full-screen terminal UI (Ink): streaming replies, vim-style INSERT/NORMAL modes, scrolling, Esc to stop, slash commands (`/help`, `/new`, `/model`, `/auto`, `/voice`, `/models`, `/history`, `/remember`, `/facts`, `/edit`, `/review`, `/audit`, `/debt`, `/quit`).
- **One-shot commands**: `elliot ask` (with piped context), `elliot explain` for piped error output.
- **Model router**: picks coder / fast / reason per message (only installed models; `AUTO_REASON` off by default so the slow reasoning model is never chosen automatically). Manual `-m` and `/model` always win.
- **Persona**: concise "plain" voice and a dry "alderson" voice; every code answer ends with a `Not checked:` line, moved out of code blocks automatically if the model misplaces it.
- **Memory** (SQLite, `memory/elliot.db`): per-project conversations that continue across runs, project facts in the system prompt, `elliot history` / `resume` / `remember` / `facts`. Falls back to temporary memory if the database is locked or unwritable.
- **File tools** sandboxed to the current folder: `elliot read` / `find` / `ls`; no `..` or symlink escapes, `.git` / `node_modules` / secret files off limits, no delete operation.
- **Confirmed edits**: `elliot edit` and `/edit` — the model can only *propose* a change (tool-calling loop tolerant of imperfect JSON); the diff is shown and the file is written only after `y` (or `--yes`), refusing if the file changed meanwhile. JavaScript edits that would break a file's syntax are sent back to the model instead of being shown.
- **Ponytail review**: `elliot review` (uncommitted / staged / branch / file), `elliot audit` (bounded, entry points first) and `elliot debt` (`shortcut:` ledger). Findings are ranked bug > security > perf > test > style, each with what / why / fix / if ignored.
- **One-click start**: `start-elliot.bat` / `start-elliot.sh` work from any drive letter (repo or pendrive layout), start Ollama only if needed, warm up the coder model and open a terminal with `elliot` on PATH.
- **Setup and diagnostics**: `npm run setup` (idempotent first-run checks), `elliot doctor`, `elliot models`, `elliot version`.
- **Local HTTP API** for Edward and the phone: `/api/health`, `/api/models`, `/api/chat` (SSE), `/api/chat/test`.
- **Tests**: unit tests for every module (`npm test`) and an end-to-end smoke test (`npm run e2e`) that drives the real tools, memory and review plumbing on a temporary git project.

### Requirements
- Node.js 22+ and Ollama. Default models: `qwen2.5-coder:7b` (coder), `qwen3:4b` (tools), `nomic-embed-text` (embeddings); optional `qwen2.5-coder:1.5b` (fast), `deepseek-r1:8b` (reason), `qwen3.5:9b` (vision).

[0.1.0]: https://github.com/PRASHANTH-GOWDA-C/E.L.L.I.O.T/releases/tag/v0.1.0
