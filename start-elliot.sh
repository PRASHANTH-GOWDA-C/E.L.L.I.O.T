#!/usr/bin/env bash
# start-elliot.sh - start Elliot on Linux / WSL (same steps as start-elliot.bat).
#
#   bash start-elliot.sh      starts Ollama if needed, then opens a shell with `elliot` ready
#   source start-elliot.sh    same, but sets PATH in your current shell instead
#
# Layouts: pendrive  <mount>/start-elliot.sh + <mount>/elliot/{app,models,runtime,...}
#          repo      <repo>/start-elliot.sh  + <repo>/{app,bin,...}

# When sourced, don't leak strict mode into the user's shell.
(return 0 2>/dev/null) && SOURCED=1 || SOURCED=0
if [ "$SOURCED" = 0 ]; then set -euo pipefail; fi

elliot_fail() {
  echo "[Elliot] $*" >&2
  if [ "$SOURCED" = 1 ]; then return 1; else exit 1; fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Where is Elliot? (pendrive layout first, then repo layout)
if [ -f "$HERE/elliot/app/cli/index.js" ]; then
  ELLIOT_HOME="$HERE/elliot"
elif [ -f "$HERE/app/cli/index.js" ]; then
  ELLIOT_HOME="$HERE"
else
  elliot_fail "Cannot find Elliot's app folder next to this script ($HERE)" || return 1
fi

# 2. Ollama options (pendrive models only if that folder exists)
if [ -d "$HERE/elliot/models" ]; then export OLLAMA_MODELS="$HERE/elliot/models"; fi
export OLLAMA_KEEP_ALIVE=-1
export OLLAMA_MAX_LOADED_MODELS=3

# 3. Node.js and the elliot command on PATH
if [ -x "$ELLIOT_HOME/runtime/node/bin/node" ]; then export PATH="$ELLIOT_HOME/runtime/node/bin:$PATH"; fi
export PATH="$ELLIOT_HOME/bin:$PATH"
command -v node >/dev/null 2>&1 || { elliot_fail "Node.js was not found. Install Node.js 22+ from https://nodejs.org" || return 1; }

# 4. Find Ollama (portable copy first)
OLLAMA_EXE=""
if [ -x "$ELLIOT_HOME/runtime/ollama/ollama" ]; then OLLAMA_EXE="$ELLIOT_HOME/runtime/ollama/ollama"
elif command -v ollama >/dev/null 2>&1; then OLLAMA_EXE="$(command -v ollama)"; fi

ollama_up() { curl -s -o /dev/null -m 2 http://127.0.0.1:11434/api/version; }

# 5. Start Ollama unless it is already running
if ollama_up; then
  echo "[Elliot] Ollama is already running."
  if [ -n "${OLLAMA_MODELS:-}" ]; then
    echo "[Elliot] Note: it keeps its own models folder. To use $OLLAMA_MODELS, stop it and run this again."
  fi
else
  if ! pgrep -x ollama >/dev/null 2>&1; then
    [ -n "$OLLAMA_EXE" ] || { elliot_fail "Ollama is not installed: https://ollama.com/download" || return 1; }
    mkdir -p "$ELLIOT_HOME/logs"
    echo "[Elliot] Starting Ollama (log: $ELLIOT_HOME/logs/ollama.log) ..."
    nohup "$OLLAMA_EXE" serve >"$ELLIOT_HOME/logs/ollama.log" 2>&1 &
  fi
  # 6. Wait until it answers (max 60 s)
  echo "[Elliot] Waiting for Ollama ..."
  waited=0
  until ollama_up; do
    if [ "$waited" -ge 60 ]; then
      elliot_fail "Ollama did not answer at http://127.0.0.1:11434 within 60 seconds (see $ELLIOT_HOME/logs/ollama.log)" || return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
fi
echo "[Elliot] Ollama is ready."

# 7. Warm up the coder model in the background
nohup node "$ELLIOT_HOME/scripts/warmup.js" >/dev/null 2>&1 &

# 8. Ready
echo
echo "  E.L.L.I.O.T is ready - type: elliot"
echo "  (the coder model is loading in the background)"
echo
if [ "$SOURCED" = 0 ]; then
  # A script can't change its parent shell's PATH, so open a new shell that has it.
  cd "$HOME"
  exec "${SHELL:-bash}" -i
fi
