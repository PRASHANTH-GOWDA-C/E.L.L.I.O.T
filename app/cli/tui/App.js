import path from 'node:path';
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useBoxMetrics, useInput, usePaste, useWindowSize } from 'ink';
import config from '../../core/config.js';
import { Session } from '../../core/session.js';
import { LlmError, isModelInstalled, listModels, missingModelError } from '../../core/llm.js';
import { runCheck } from '../../core/check.js';
import { NotCheckedFixer } from '../../core/format.js';
import { html } from './html.js';
import { parseBlocks } from './blocks.js';
import { HELP_TEXT, PLANNED_COMMANDS, ROLES } from './commands.js';

const defaultDeps = {
  createSession: (opts) => new Session(opts),
  listModels,
  runCheck,
};

const STATUS_LABELS = {
  ready: ['ready', 'green'],
  thinking: ['thinking…', 'yellow'],
  streaming: ['streaming', 'cyan'],
  stopped: ['stopped', 'yellow'],
  error: ['error', 'red'],
  checking: ['checking models…', 'yellow'],
};

const BUSY = new Set(['thinking', 'streaming', 'checking']);
const QUIT_COMMANDS = new Set(['q', 'q!', 'quit', 'qa', 'wq']);
const normaliseNewlines = (text) => text.replace(/\r\n?/g, '\n');

// ---- Presentational components ---------------------------------------------

function Header({ role, model, mode, folder }) {
  return html`
    <${Box} borderStyle="single" borderTop=${false} borderLeft=${false} borderRight=${false} borderColor="gray" flexShrink=${0}>
      <${Text} wrap="truncate">
        <${Text} color="cyan" bold>E.L.L.I.O.T<//>
        <${Text} dimColor>  ·  <//>
        <${Text}>${model}<//><${Text} dimColor> (${role})<//>
        <${Text} dimColor>  ·  <//>
        <${Text} color=${mode === 'offline' ? 'green' : 'magenta'}>${mode}<//>
        <${Text} dimColor>  ·  <//>
        <${Text}>${folder}<//>
      <//>
    <//>`;
}

function CodeBlock({ lang, code }) {
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor="gray" paddingX=${1}>
      <${Text} dimColor>${lang || 'code'}<//>
      <${Text} color="yellow">${code}<//>
    <//>`;
}

function Reply({ message }) {
  const blocks = parseBlocks(message.text);
  return html`
    <${Box} flexDirection="column" marginTop=${1}>
      <${Text} color="green" bold>Elliot<//>
      ${blocks.length === 0 && message.state === 'thinking' ? html`<${Text} dimColor>thinking…<//>` : null}
      ${blocks.map((block, i) =>
        block.type === 'code'
          ? html`<${CodeBlock} key=${i} lang=${block.lang} code=${block.code} />`
          : html`<${Text} key=${i}>${block.text}<//>`,
      )}
      ${message.state === 'stopped' ? html`<${Text} dimColor>[stopped]<//>` : null}
      ${message.state === 'error' ? html`<${Text} color="red">✖ ${message.error}<//>` : null}
    <//>`;
}

function Message({ message }) {
  if (message.role === 'user') {
    return html`
      <${Box} marginTop=${1}>
        <${Text} color="cyan" bold>› <//>
        <${Text}>${message.text}<//>
      <//>`;
  }
  if (message.role === 'info') {
    return html`
      <${Box} marginTop=${1}>
        <${Text} color=${message.level === 'error' ? 'red' : 'yellow'}>${message.text}<//>
      <//>`;
  }
  return html`<${Reply} message=${message} />`;
}

function StatusBar({ mode, status, stats }) {
  const [label, color] = STATUS_LABELS[status];
  const hint =
    mode === 'insert'
      ? 'Enter send · Esc stop/normal · /help'
      : 'j/k scroll · g/G top/bottom · i insert · :q quit';
  return html`
    <${Box} flexShrink=${0} justifyContent="space-between">
      <${Text} wrap="truncate">
        <${Text} bold color=${mode === 'insert' ? 'green' : 'blue'}>${mode === 'insert' ? '-- INSERT --' : '-- NORMAL --'}<//>
        <${Text}>  <//>
        <${Text} color=${color}>${label}<//>
        ${stats ? html`<${Text} dimColor>  · last: ${(stats.ms / 1000).toFixed(1)}s${stats.tokensPerSec !== null ? ` · ${stats.tokensPerSec} tok/s` : ''}<//>` : null}
      <//>
      <${Text} dimColor wrap="truncate">${hint}<//>
    <//>`;
}

function InputLine({ mode, input, cmdline, busy }) {
  if (mode === 'normal') {
    return html`
      <${Box} flexShrink=${0}>
        ${cmdline !== null
          ? html`<${Text}>:${cmdline}<${Text} inverse> <//><//>`
          : html`<${Text} dimColor>press i to type, : for commands<//>`}
      <//>`;
  }
  return html`
    <${Box} flexShrink=${0}>
      <${Text} color=${busy ? 'gray' : 'cyan'}>❯ <//>
      <${Text}>${input}<${Text} inverse> <//><//>
    <//>`;
}

// ---- App ---------------------------------------------------------------------

/**
 * Full-screen chat. `deps` and `onExit` exist so tests can run without Ollama.
 * @param {{ role?: string, cwd?: string, deps?: typeof defaultDeps, onExit?: () => void }} props
 */
export function App({ role: initialRole = 'coder', cwd = process.cwd(), deps = defaultDeps, onExit }) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const height = rows > 0 ? rows : 24;
  const folder = path.basename(cwd) || cwd;

  const [role, setRole] = useState(initialRole);
  const model = config.models[role].name;
  const sessionRef = useRef(null);
  sessionRef.current ??= deps.createSession({ model, cwd });

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('insert');
  const [cmdline, setCmdline] = useState(null); // ":…" in NORMAL mode
  const [status, setStatus] = useState('ready');
  const [stats, setStats] = useState(null);
  const [scroll, setScroll] = useState(null); // null = follow the newest message
  const controllerRef = useRef(null);
  const nextId = useRef(0);
  const busy = BUSY.has(status);

  // Stop a running reply if the UI is closed (Ctrl+C, :q).
  useEffect(() => () => controllerRef.current?.abort(), []);

  // ---- Scrolling ----
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const maxTop = Math.max(0, content.height - viewport.height);
  const top = scroll === null ? maxTop : Math.min(scroll, maxTop);
  const page = Math.max(1, viewport.height - 2);
  const scrollBy = (delta) => {
    const next = top + delta;
    setScroll(next >= maxTop ? null : Math.max(0, next));
  };

  // ---- Messages ----
  const addMessage = (message) => {
    const id = nextId.current++;
    setMessages((list) => [...list, { id, ...message }]);
    return id;
  };
  const updateMessage = (id, update) =>
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, ...update(m) } : m)));
  const info = (text, level = 'info') => {
    addMessage({ role: 'info', text, level });
    setScroll(null);
  };

  const quit = () => {
    controllerRef.current?.abort();
    onExit?.();
    exit();
  };

  async function sendMessage(text) {
    const controller = new AbortController();
    controllerRef.current = controller;
    addMessage({ role: 'user', text });
    const replyId = addMessage({ role: 'assistant', text: '', state: 'thinking' });
    setStatus('thinking');
    setScroll(null);

    const fixer = new NotCheckedFixer();
    const append = (chunk, extra = {}) => updateMessage(replyId, (m) => ({ text: m.text + chunk, ...extra }));

    try {
      const stream = sessionRef.current.send(text, { signal: controller.signal });
      let result;
      let first = true;
      while (!(result = await stream.next()).done) {
        if (first) {
          setStatus('streaming');
          first = false;
        }
        const out = fixer.push(result.value);
        if (out) append(out);
      }
      append(fixer.end(), { state: 'done' });
      setStats(result.value);
      setStatus('ready');
    } catch (err) {
      if (err instanceof LlmError && err.code === 'ABORTED') {
        append(fixer.end(), { state: 'stopped' });
        setStatus('stopped');
      } else {
        updateMessage(replyId, () => ({ state: 'error', error: err.message }));
        setStatus('error');
      }
    } finally {
      controllerRef.current = null;
    }
  }

  async function switchModel(nextRole) {
    if (!nextRole) {
      info(`Current model: ${role} (${model}). Usage: /model ${ROLES.join('|')}`);
      return;
    }
    if (!ROLES.includes(nextRole)) {
      info(`Unknown model role "${nextRole}" — use one of: ${ROLES.join(', ')}`, 'error');
      return;
    }
    const name = config.models[nextRole].name;
    try {
      const installed = await deps.listModels();
      if (!isModelInstalled(installed, name)) {
        info(missingModelError(name).message, 'error');
        return;
      }
    } catch (err) {
      info(err.message, 'error');
      return;
    }
    sessionRef.current.model = name;
    setRole(nextRole);
    info(`Switched to ${nextRole} (${name}).`);
  }

  async function showModelsReport() {
    setStatus('checking');
    const lines = [];
    try {
      await deps.runCheck({ print: (text = '') => lines.push(text) });
      info(lines.join('\n'));
    } catch (err) {
      info(`Model check failed: ${err.message}`, 'error');
    } finally {
      setStatus('ready');
    }
  }

  function runCommand(commandLine) {
    const [name, ...args] = commandLine.slice(1).trim().split(/\s+/);
    if (busy && !['help', 'quit'].includes(name)) {
      info('Busy — press Esc to stop the reply first.', 'error');
      return;
    }
    switch (name) {
      case 'help':
        info(HELP_TEXT);
        break;
      case 'clear':
        sessionRef.current = deps.createSession({ model, cwd });
        setMessages([]);
        setStats(null);
        setStatus('ready');
        setScroll(null);
        break;
      case 'model':
        switchModel(args[0]);
        break;
      case 'models':
        showModelsReport();
        break;
      case 'quit':
        quit();
        break;
      default:
        if (PLANNED_COMMANDS.has(name)) info(`/${name} is coming in a later step.`);
        else info(`Unknown command /${name} — try /help`, 'error');
    }
  }

  function submit() {
    const text = input.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      setInput('');
      runCommand(text);
      return;
    }
    if (busy) return; // keep the draft; Enter works again when the reply ends
    setInput('');
    sendMessage(text);
  }

  function runEx(command) {
    const cmd = command.trim();
    if (!cmd) return;
    if (QUIT_COMMANDS.has(cmd)) quit();
    else info(`Not an editor command: ${cmd}`, 'error');
  }

  // ---- Keys ----
  useInput((typed, key) => {
    if (key.pageUp) return scrollBy(-page);
    if (key.pageDown) return scrollBy(page);

    if (mode === 'insert') {
      if (key.escape) {
        if (controllerRef.current) controllerRef.current.abort();
        else setMode('normal');
        return;
      }
      if (key.return) return submit();
      if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (typed) setInput((v) => v + normaliseNewlines(typed));
      return;
    }

    // NORMAL mode, typing a ":" command
    if (cmdline !== null) {
      if (key.escape) return setCmdline(null);
      if (key.return) {
        setCmdline(null);
        return runEx(cmdline);
      }
      if (key.backspace || key.delete) return setCmdline((c) => (c ? c.slice(0, -1) : null));
      if (typed && !key.ctrl && !key.meta) setCmdline((c) => c + typed);
      return;
    }

    // NORMAL mode
    if (key.escape) {
      controllerRef.current?.abort();
      return;
    }
    if (typed === 'j' || key.downArrow) scrollBy(1);
    else if (typed === 'k' || key.upArrow) scrollBy(-1);
    else if (typed === 'g') setScroll(0);
    else if (typed === 'G') setScroll(null);
    else if (typed === 'i' || typed === 'a') setMode('insert');
    else if (typed === ':') setCmdline('');
  });

  usePaste((text) => {
    if (mode === 'insert') setInput((v) => v + normaliseNewlines(text));
  });

  return html`
    <${Box} flexDirection="column" height=${height}>
      <${Header} role=${role} model=${model} mode=${config.aiMode} folder=${folder} />
      <${Box} ref=${viewportRef} flexGrow=${1} flexDirection="column" overflow="hidden" contentOffsetY=${top}>
        <${Box} ref=${contentRef} flexDirection="column" flexShrink=${0} paddingX=${1}>
          ${messages.length === 0
            ? html`<${Box} marginTop=${1}><${Text} dimColor>Ask me anything about ${folder}. Type /help for commands.<//><//>`
            : messages.map((m) => html`<${Message} key=${m.id} message=${m} />`)}
        <//>
      <//>
      <${StatusBar} mode=${mode} status=${status} stats=${stats} />
      <${InputLine} mode=${mode} input=${input} cmdline=${cmdline} busy=${busy} />
    <//>`;
}
