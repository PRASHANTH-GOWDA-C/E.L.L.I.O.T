<div align="center">

<img src="assets/elliot-icon.svg" width="120" alt="Elliot icon"/>

# E.L.L.I.O.T

### **E**nhanced **L**ogical **I**ntelligence & **O**perational **T**echnology

**A portable, offline-first AI companion that lives on a pendrive.**

*Plug it into any laptop → Elliot wakes up, remembers you, and helps you build.*

![status](https://img.shields.io/badge/status-in%20development-orange)
![offline](https://img.shields.io/badge/mode-offline%20first-blue)
![node](https://img.shields.io/badge/Node.js-22%2B-green)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

[Features](#-features) · [Models](#-models) · [CLI](#%EF%B8%8F-the-elliot-command) · [Architecture](#%EF%B8%8F-architecture) · [Plugins](#-plugins-tools) · [Edward](edward/README.md) · [Roadmap](#%EF%B8%8F-roadmap)

</div>

---

## 📖 What is Elliot?

Elliot is a personal AI companion that runs **entirely from a USB pendrive**. It writes and reviews code, works with your files, remembers your projects, and works **without internet**. At hackathons, flip one switch and Elliot goes **online** for stronger cloud models.

Elliot is a **command-line tool**: type `elliot` in any terminal, like `vim` or `git`.

| Part | Role |
|---|---|
| 🧠 **Pendrive (64 GB)** | Elliot's **brain**: models, memory, personality, settings |
| 💻 **Laptop** | Elliot's **body**: lends its CPU and RAM to run the brain |
| 📱 **Elliot Lite** | A small Elliot that lives on the Edward phone (see [Edward](edward/README.md)) |
| 🤖 **Edward** | Elliot's **physical form**: face, ears and voice on your desk |

---

## ✨ Features

### 👨‍💻 Coding partner
- Writes, explains and debugs code (JavaScript, Node.js, HTML/CSS, MySQL and more)
- Reads error messages and stack traces and points to the cause
- **CP mode** for LeetCode, Codeforces and CodeChef: hint → approach → code, step by step, plus a local test-case runner
- **[Ponytail](https://github.com/DietrichGebert/ponytail) coding rules**: writes only what the task needs, and never cuts validation, error handling, security or accessibility

### 📁 File worker
- Reads your project folders so answers match your real code
- Creates files and project templates
- **Always shows a diff and asks before writing.** It never deletes anything on its own.

### 🧠 Memory
- Remembers you, your projects and past conversations, on **any** PC
- A single SQLite file, fast and safe on slow USB drives
- Encrypted weekly backup to the cloud

### ⚡ Hackathon mode (online switch)
- One toggle moves from local models to cloud models through **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)**, with automatic fallback across free-tier providers
- Problem-statement breakdown, 24-hour build plan, pitch outline, README generator
- API keys are stored **encrypted**, behind a password

### 🔍 Review commands
| Command | What it does |
|---|---|
| `/review` | Reviews current changes for bugs, security, load, missing tests and speed |
| `/audit` | Same checks on the whole project, most important first |
| `/debt` | Collects `shortcut:` comments into a to-do list |

Every reply ends with **what Elliot didn't check**.

### 🎙️ Voice *(planned)*
Ears: **Parakeet TDT 0.6B** or **Whisper** (for Kannada and other languages) · Voice: **Piper TTS** · Wake word: **openWakeWord** ("Hey Elliot")

---

## 🤖 Models

All local models run through **Ollama**. Elliot keeps **three loaded at once** and loads the others only when needed.

### Laptop (16 GB RAM, CPU-only)
| Model | Size | Job | When |
|---|---|---|---|
| `qwen2.5-coder:7b` | 4.7 GB | **Main brain**: code + chat | Always loaded |
| `granite4.2:3b` | 2.2 GB | **Hands**: tool calls | Always loaded |
| `nomic-embed-text` | 0.3 GB | **Memory search** | Always loaded |
| `deepseek-r1:8b` | 5.2 GB | Hard debugging and logic ("think hard") | On demand |
| `qwen3.5:9b` | 6.6 GB | General chat + reading screenshots | On demand |
| `qwen3.5:0.8b` | 1.0 GB | Quick answers / weak PCs | On demand |
| `deepseek-coder-v2:16b` | 8.9 GB | Big code files (optional, slower) | On demand |

### Elliot Lite (Samsung Galaxy A10, 2 GB RAM)
| Model | Job |
|---|---|
| `qwen3.5:0.8b` (or another ~1B model) via **llama.cpp** in Termux | Chat, notes, reminders, simple questions. **Not for serious coding.** |

### Voice
| Model | Size | Job |
|---|---|---|
| Parakeet TDT 0.6B | ~0.7 GB | Speech-to-text (English, fast) |
| Whisper Turbo | ~1.6 GB | Speech-to-text (99 languages, incl. Kannada) |
| Piper (en_US voice) | ~0.1 GB | Text-to-speech |

### Online (hackathon mode)
**OmniRoute** (headless) gives one OpenAI-compatible endpoint with automatic fallback across cloud providers.

> 💡 Model names and sizes were current when this was written. Check [ollama.com/library](https://ollama.com/library) before downloading.

---

## 🏗️ Architecture

```
You ──► `elliot` CLI (Node.js · Ink full-screen terminal UI · one-shot commands)
          │
          ├── Personality ── Ponytail coding rules
          ├── Router ─────── coder / tools / reasoning / vision model
          │
          ├── Offline ────── Ollama (portable) ── models on the pendrive
          ├── Hackathon ──── OmniRoute (headless) ── cloud models with fallback
          │
          ├── Plugins ────── MCP tools (files, git, docs, nmap, GPG…)
          ├── Memory ─────── SQLite + nomic-embed search
          ├── Local API ──── small HTTP server, only for Edward / the phone
          └── Edward ─────── face / ears / voice over USB or Wi-Fi
```

The core (models, memory, tools) lives in one place and is shared by the CLI and the local API.

Elliot talks to every model through one **OpenAI-compatible** client, so switching between offline and online changes only one URL.

---

## 🔌 Plugins (tools)

Elliot uses **MCP (Model Context Protocol)** for plugins. Each tool is a small server that can be switched on or off.

### Offline
| Area | Tools |
|---|---|
| Coding | Filesystem, git, ripgrep, ESLint/Prettier, Node/Python runner, test runner |
| Competitive programming | Test-case runner, stress tester, template library |
| Knowledge | Kiwix (offline Wikipedia / Stack Overflow), DevDocs, notes search |
| Documents | pdftotext / pdf.js, Tesseract OCR |
| Vision | Screenshot tool + vision model |
| Productivity | To-dos, reminders, timers, .ics calendar, clipboard, calculator |
| System | Resource monitor, app launcher, file organizer, backups |
| Media | ffmpeg, Piper (Shorts bot editing) |
| Security lab *(own devices only)* | nmap, tshark, rkhunter, ClamAV, GPG/LUKS, pwntools (CTFs) |
| Hardware | Edward bridge, NodeMCU sensors, INA219 |

### Online
| Area | Tools |
|---|---|
| Brain | OmniRoute |
| Research | Web search + fetch, Apify, SearXNG |
| Dev workflow | GitHub (`gh`), npm, Vercel / Netlify / Render deploys |
| Remote control | Telegram bot |
| Accounts | Gmail, Google Calendar/Drive, Notion |
| Content | Pexels + YouTube Data API (Shorts bot), Instagram Graph API, Canva |

> ⚖️ Scanning and cracking tools are limited to **your own devices, your home network, or CTF platforms** (picoCTF, TryHackMe). Elliot asks for confirmation and only targets your home network range.

---

## ⌨️ The `elliot` command

Elliot runs **inside any terminal** (PowerShell, cmd, VS Code, WSL), from whatever folder you're in, so he always sees the project you're working on.

| Command | What it does |
|---|---|
| `elliot` | Opens Elliot full-screen in the terminal (chat, streaming replies) |
| `elliot ask "…"` | One quick answer, then back to your shell |
| `elliot review` | Reviews your current git changes |
| `elliot audit` | Reviews the whole project, most important first |
| `elliot fix <file>` | Proposes a fix as a diff; applies it only if you press `y` |
| `<command> 2>&1 \| elliot explain` | Explains piped error output |
| `elliot models` | Shows which models are installed and loaded |
| `elliot doctor` | One health report: Node, Ollama, models, memory database, current project |
| `elliot online` / `elliot offline` | Switches hackathon mode on or off |

**Inside full-screen mode:** `Enter` to send · `Esc` to stop a reply · `j`/`k` or arrows to scroll · `/review`, `/audit`, `/debt` commands · `:q` to quit.

Built with **Ink** (React for terminals). Installed on the laptop with `npm link`; the pendrive has its own launcher.

---

## 💻 Requirements

| | Minimum | Recommended |
|---|---|---|
| **RAM** | 8 GB (3B models only) | **16 GB** (7–9B models) |
| **GPU** | Not required | Not required |
| **OS** | Windows 10/11 | Windows 11 (+ WSL for Linux tools) |
| **Node.js** | **22+** (required by Ink 8) | Latest LTS |
| **Pendrive** | 32 GB, exFAT | **64 GB+, USB 3.2, 150+ MB/s read** |

> ⚠️ Test every new pendrive with **H2testw** (Write + Verify) before use. Fake or faulty drives silently corrupt data.

**Tips:** close Chrome while big models run · models load once per session, then stay in RAM.

---

## 📂 Pendrive layout

```
E.L.L.I.O.T/
├── start-elliot.bat        ← double-click to start (Windows)
├── start-elliot.sh         ← same for Linux / WSL
├── elliot/
│   ├── app/                ← Elliot's code (bundled, no node_modules)
│   ├── bin/                ← `elliot` launcher (elliot.cmd / elliot)
│   ├── models/             ← Ollama models
│   ├── runtime/            ← portable Ollama, Node.js
│   ├── voice/              ← Parakeet / Whisper / Piper
│   ├── knowledge/          ← offline docs
│   └── memory/             ← elliot.db (SQLite)
└── tools/                  ← portable VS Code + Git
```

---

## 🚀 Quick start

1. Plug in the pendrive.
2. Double-click **`start-elliot.bat`** (Linux / WSL: `bash start-elliot.sh`).
3. A terminal opens in your home folder: type **`elliot`**. The coder model keeps loading in the background (1–4 min the first time, depending on drive speed).

What `start-elliot.bat` does (abridged; see the file for the full version):

```bat
@echo off
set "HERE=%~dp0"
rem Pendrive layout (X:\elliot\...) or repo layout (app\ next to the script)
if exist "%HERE%elliot\app\cli\index.js" (set "ELLIOT_HOME=%HERE%elliot") else (set "ELLIOT_HOME=%HERE%")
rem Use the pendrive's models only if that folder exists
if exist "%HERE%elliot\models\" set "OLLAMA_MODELS=%HERE%elliot\models"
set OLLAMA_KEEP_ALIVE=-1
set OLLAMA_MAX_LOADED_MODELS=3
set "PATH=%ELLIOT_HOME%\runtime\node;%ELLIOT_HOME%\bin;%PATH%"
rem Start Ollama only if it isn't running, then wait until http://127.0.0.1:11434 answers
start "Ollama" /min ollama serve
start "Elliot warm-up" /min node "%ELLIOT_HOME%\scripts\warmup.js"
start "Elliot" /d "%USERPROFILE%" cmd /k "echo E.L.L.I.O.T is ready - type: elliot"
```

It uses `%~dp0`, so it works whatever drive letter Windows assigns and from any folder (the repo on an SSD too). If Ollama is already running (for example the tray app), it keeps using that Ollama and its models folder.

### First-time setup (on a new laptop or checkout)
```powershell
npm run setup     # checks Node 22+, installs dependencies, checks Ollama + models, runs npm link
elliot doctor     # one report: Node, Ollama, models, memory database, current project
```
Both are safe to run again at any time.

### First-time model download
```powershell
setx OLLAMA_MODELS "F:\elliot\models"   # use your pendrive's letter
ollama pull qwen2.5-coder:7b
ollama pull granite4.2:3b
ollama pull nomic-embed-text
ollama pull qwen3.5:0.8b
ollama pull deepseek-r1:8b
ollama pull qwen3.5:9b
```

---

## ☁️ Cloud

| What | Where |
|---|---|
| Source code | GitHub (private while building) |
| Terminal app installers | GitHub Releases |
| Memory backups | Google Drive / private repo, **encrypted** (`age` or GPG) |
| Telegram bot + online-mode Elliot | Render / Railway / Fly.io, or a free cloud VM |
| Models | ❌ Not uploaded. Re-downloaded with Ollama |

Secrets live in `.env` (git-ignored). The terminal is never exposed publicly; use **Tailscale** for private remote access.

---

## 🗺️ Roadmap

- [ ] Portable Ollama + core models on the pendrive
- [ ] Start script + Node.js backend
- [ ] `elliot` CLI: full-screen terminal UI with streaming replies
- [ ] Memory (SQLite) + "continue where we left off"
- [ ] File tools with diff + confirmation
- [ ] Ponytail rules + `/review`, `/audit`, `/debt`
- [ ] **Elliot v1** 🎉
- [ ] Hackathon mode (OmniRoute + encrypted keys)
- [ ] MCP plugin system + offline docs
- [ ] One-shot commands: `ask`, `fix`, `explain` (piped input)
- [ ] Voice (Parakeet / Whisper + Piper + wake word)
- [ ] Elliot Lite on the Galaxy A10
- [ ] Edward integration (see [Edward roadmap](edward/README.md#%EF%B8%8F-roadmap))

---

## 🔒 Safety rules

- Never writes or deletes files without your confirmation
- API keys encrypted on the pendrive, so a lost drive doesn't leak them
- Every reply lists what wasn't checked
- Security tools only on your own devices / CTFs
- Memory backed up automatically; models can always be re-downloaded

---

## 🙏 Built with

[Ollama](https://ollama.com) · [llama.cpp](https://github.com/ggml-org/llama.cpp) · [OmniRoute](https://github.com/diegosouzapw/OmniRoute) · [Ponytail](https://github.com/DietrichGebert/ponytail) · [Qwen](https://ollama.com/library/qwen2.5-coder) · [DeepSeek](https://ollama.com/library/deepseek-r1) · [Piper](https://github.com/rhasspy/piper) · [Whisper](https://github.com/openai/whisper) · [Ink](https://github.com/vadimdemedes/ink)

---

<div align="center">

Made by **[Prashanth](https://github.com/PRASHANTH-GOWDA-C)**, ISE @ DBIT Bengaluru

</div>
