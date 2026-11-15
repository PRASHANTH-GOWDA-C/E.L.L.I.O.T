import path from 'node:path';
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useBoxMetrics, useInput, usePaste, useWindowSize } from 'ink';
import config, { VOICES } from '../../core/config.js';
import { chooseModel } from '../../core/router.js';
import { Session } from '../../core/session.js';
import { LlmError, isModelInstalled, listModels, missingModelError } from '../../core/llm.js';
import { runCheck } from '../../core/check.js';
import { NotCheckedFixer, diffLineKind, fixNotChecked, formatFacts, formatHistory } from '../../core/format.js';
import { parseFact } from '../../core/memory.js';
import { runAgent } from '../../core/agent.js';
import { createFileTools } from '../../core/tools/files.js';
import { html } from './html.js';
import { parseBlocks } from './blocks.js';
import { HELP_TEXT, PLANNED_COMMANDS, ROLES } from './commands.js';

const defaultDeps = {
  createSession: (opts) => new Session(opts),
  listModels,
  runCheck,
  runAgent,
  createFileTools,
};

const STATUS_LABELS = {
  ready: ['ready', 'green'],
  thinking: ['thinking…', 'yellow'],
  streaming: ['streaming', 'cyan'],
  stopped: ['stopped', 'yellow'],
  error: ['error', 'red'],
  checking: ['checking models…', 'yellow'],
  editing: ['reading files…', 'yellow'],
  review: ['review the change', 'magenta'],
};

const BUSY = new Set(['thinking', 'streaming', 'checking', 'editing', 'review']);
const QUIT_COMMANDS = new Set(['q', 'q!', 'quit', 'qa', 'wq']);
const normaliseNewlines = (text) => text.replace(/\r\n?/g, '\n');

// ---- Presentational components ---------------------------------------------

function Header({ role, auto, model, mode, voice, folder }) {
  return html`
    <${Box} borderStyle="single" borderTop=${false} borderLeft=${false} borderRight=${false} borderColor="gray" flexShrink=${0}>
      <${Text} wrap="truncate">
        <${Text} color="cyan" bold>E.L.L.I.O.T<//>
        <${Text} dimColor>  ·  <//>
        <${Text}>${model}<//><${Text} dimColor> (${role} · ${auto ? 'auto' : 'manual'})<//>
        <${Text} dimColor>  ·  <//>
        <${Text}>${voice}<//>
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

function StatusBar({ mode, status, stats, route, columns }) {
  const [label, color] = STATUS_LABELS[status];
  const modeText = mode === 'insert' ? '-- INSERT --' : '-- NORMAL --';
  const statsText = stats
    ? `  · last: ${(stats.ms / 1000).toFixed(1)}s${stats.tokensPerSec !== null ? ` · ${stats.tokensPerSec} tok/s` : ''}`
    : '';
  const routeText = `  · ${route}`;
  const hint =
    mode === 'insert'
      ? 'Enter send · Esc stop/normal · /help'
      : 'j/k scroll · g/G top/bottom · i insert · :q quit';
  // The key hint is the least important part: drop it when the line is full.
  const leftLength = modeText.length + 2 + label.length + statsText.length + routeText.length;
  const showHint = leftLength + 2 + hint.length <= columns;
  return html`
    <${Box} flexShrink=${0} justifyContent="space-between">
      <${Text} wrap="truncate">
        <${Text} bold color=${mode === 'insert' ? 'green' : 'blue'}>${modeText}<//>
        <${Text}>  <//>
        <${Text} color=${color}>${label}<//>
        ${statsText ? html`<${Text} dimColor>${statsText}<//>` : null}
        <${Text} dimColor>${routeText}<//>
      <//>
      ${showHint ? html`<${Text} dimColor wrap="truncate">${hint}<//>` : null}
    <//>`;
}

const DIFF_COLORS = { header: 'white', hunk: 'cyan', add: 'green', del: 'red', meta: 'gray', context: undefined };

/** Proposed change: path, coloured diff (scrollable), y/N question. */
function DiffPanel({ proposal, index, total, scroll, height }) {
  const lines = proposal.diff.trimEnd().split('\n');
  const visible = Math.max(1, height - 4); // border + title + question
  const top = Math.min(scroll, Math.max(0, lines.length - visible));
  const what = proposal.isNew ? 'new file' : `+${proposal.additions} −${proposal.deletions}`;
  const more = lines.length > visible ? ` · lines ${top + 1}-${Math.min(top + visible, lines.length)} of ${lines.length}` : '';
  return html`
    <${Box} flexDirection="column" flexGrow=${1} borderStyle="round" borderColor="magenta" paddingX=${1} overflow="hidden">
      <${Text} bold wrap="truncate">Proposed change${total > 1 ? ` (${index + 1}/${total})` : ''}: ${proposal.absolutePath} <${Text} dimColor>(${what}${more})<//><//>
      <${Box} flexDirection="column" flexGrow=${1} overflow="hidden">
        ${lines.slice(top, top + visible).map((line, i) => {
          const kind = diffLineKind(line);
          return html`<${Text} key=${i} color=${DIFF_COLORS[kind]} bold=${kind === 'header'} wrap="truncate">${line || ' '}<//>`;
        })}
      <//>
      <${Text}><${Text} bold color="magenta">Apply this change? [y/N]<//><${Text} dimColor>  y apply · n/Esc skip · j/k scroll<//><//>
    <//>`;
}

function InputLine({ mode, input, cmdline, busy, reviewing }) {
  if (reviewing) {
    return html`<${Box} flexShrink=${0}><${Text} dimColor>Nothing is written unless you press y.<//><//>`;
  }
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
 * @param {{
 *   role?: string, voice?: string, cwd?: string,
 *   memory?: import('../../core/memory.js').Memory | null,  // null = no memory
 *   fresh?: boolean,          // start a new conversation instead of continuing
 *   conversationId?: number,  // resume this conversation
 *   deps?: typeof defaultDeps, onExit?: () => void,
 * }} props role: a manual model role; undefined = automatic routing per message
 */
export function App({
  role: initialRole,
  voice: initialVoice = config.voice,
  cwd = process.cwd(),
  memory = null,
  fresh = false,
  conversationId,
  deps = defaultDeps,
  onExit,
}) {
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();
  const height = rows > 0 ? rows : 24;
  const folder = path.basename(cwd) || cwd;

  const [manualRole, setManualRole] = useState(initialRole ?? null); // null = automatic
  const [activeRole, setActiveRole] = useState(initialRole ?? 'coder'); // role of the latest message
  const [route, setRoute] = useState(initialRole ? `manual: ${initialRole}` : 'auto');
  const [voice, setVoice] = useState(initialVoice);
  const model = config.models[activeRole].name;
  const sessionRef = useRef(null);
  const newSession = (opts = {}) => deps.createSession({ model, cwd, voice, memory, ...opts });
  sessionRef.current ??= newSession({ continue: !fresh, conversationId });

  // Installed models, for the router. null until known (router then uses coder).
  const installedRef = useRef(null);
  const refreshInstalled = async () => {
    try {
      installedRef.current = await deps.listModels();
    } catch {
      installedRef.current = null;
    }
    return installedRef.current;
  };
  useEffect(() => {
    refreshInstalled();
  }, []);

  const nextId = useRef(0);
  // Show the continued conversation (seeded history) on screen.
  const [messages, setMessages] = useState(() => {
    const session = sessionRef.current;
    if (!session.conversationId || session.history.length === 0) return [];
    const shown = session.history.map((m) => ({
      id: nextId.current++,
      role: m.role,
      text: m.role === 'assistant' ? fixNotChecked(m.content) : m.content,
      state: 'done',
    }));
    const title = session.title ? ` “${session.title}”` : '';
    shown.push({
      id: nextId.current++,
      role: 'info',
      level: 'info',
      text: `Continuing chat #${session.conversationId}${title} · /new starts fresh`,
    });
    return shown;
  });
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('insert');
  const [cmdline, setCmdline] = useState(null); // ":…" in NORMAL mode
  const [status, setStatus] = useState('ready');
  const [stats, setStats] = useState(null);
  const [scroll, setScroll] = useState(null); // null = follow the newest message
  const [review, setReview] = useState(null); // { proposals, index, scroll } while a diff awaits y/n
  const controllerRef = useRef(null);
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

  // Memory problems (locked DB…) are shown in the chat, never written over the screen.
  useEffect(() => {
    if (!memory) return undefined;
    if (memory.warning) info(memory.warning, 'error');
    memory.onWarn = (warning) => info(warning, 'error');
    return () => {
      memory.onWarn = null;
    };
  }, [memory]);

  const quit = () => {
    controllerRef.current?.abort();
    onExit?.();
    exit();
  };

  async function sendMessage(text) {
    // Manual choice (/model, -m) wins; otherwise route this message.
    let role = manualRole;
    let label = `manual: ${manualRole}`;
    if (!role) {
      const choice = chooseModel(text, { history: sessionRef.current.history, installed: installedRef.current });
      role = choice.role;
      label = `auto: ${choice.role} (${choice.reason})`;
    }
    sessionRef.current.model = config.models[role].name;
    setActiveRole(role);
    setRoute(label);

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
      const how = manualRole ? 'manual' : 'automatic';
      info(`Current model: ${activeRole} (${model}), ${how}. Usage: /model ${ROLES.join('|')} · /auto`);
      return;
    }
    if (!ROLES.includes(nextRole)) {
      info(`Unknown model role "${nextRole}" — use one of: ${ROLES.join(', ')}`, 'error');
      return;
    }
    const name = config.models[nextRole].name;
    try {
      const installed = await deps.listModels();
      installedRef.current = installed;
      if (!isModelInstalled(installed, name)) {
        info(missingModelError(name).message, 'error');
        return;
      }
    } catch (err) {
      info(err.message, 'error');
      return;
    }
    sessionRef.current.model = name;
    setManualRole(nextRole);
    setActiveRole(nextRole);
    setRoute(`manual: ${nextRole}`);
    info(`Switched to ${nextRole} (${name}). /auto goes back to automatic.`);
  }

  function enableAuto() {
    setManualRole(null);
    setRoute('auto');
    info('Automatic model choice is on: each message picks coder, fast or reason.');
  }

  function switchVoice(nextVoice) {
    if (!nextVoice) {
      info(`Current voice: ${voice}. Usage: /voice ${VOICES.join('|')}`);
      return;
    }
    if (!VOICES.includes(nextVoice)) {
      info(`Unknown voice "${nextVoice}" — use one of: ${VOICES.join(', ')}`, 'error');
      return;
    }
    sessionRef.current.voice = nextVoice; // keeps the conversation
    setVoice(nextVoice);
    info(`Voice: ${nextVoice}.`);
  }

  function startNewConversation() {
    sessionRef.current = newSession();
    setMessages([]);
    setStats(null);
    setStatus('ready');
    setScroll(null);
  }

  function showHistory() {
    if (!memory) return info('Memory is off.', 'error');
    const list = memory.listConversations(sessionRef.current.project);
    if (list.length === 0) return info('No saved conversations for this project yet.');
    info(`${formatHistory(list, sessionRef.current.conversationId)}\n\nResume one with: elliot resume <id>`);
  }

  function rememberFact(text) {
    if (!memory) return info('Memory is off.', 'error');
    const fact = parseFact(text);
    if (!fact) return info('Usage: /remember key: value   e.g. /remember stack: Node + MySQL', 'error');
    if (!memory.saveFact(sessionRef.current.project, fact.key, fact.value)) return; // warning shown
    sessionRef.current.refreshFacts();
    info(`Remembered: ${fact.key} = ${fact.value}`);
  }

  function showFacts() {
    if (!memory) return info('Memory is off.', 'error');
    const list = memory.getFacts(sessionRef.current.project);
    if (list.length === 0) return info('No notes yet. Add one with /remember key: value');
    info(`Notes for this project\n${formatFacts(list)}`);
  }

  // ---- File edits (/edit) ----
  // The agent can only PROPOSE; files are written solely in decideEdit(true),
  // i.e. after the user pressed y on the diff panel.
  const filesRef = useRef(null);

  async function runEdit(instruction) {
    if (!instruction) return info('Usage: /edit <instruction>   e.g. /edit add a JSDoc comment to src/app.js', 'error');
    try {
      filesRef.current ??= deps.createFileTools(cwd);
    } catch (err) {
      return info(`Cannot use files in ${cwd}: ${err.message}`, 'error');
    }
    const role = manualRole ?? 'coder';
    const editModel = config.models[role].name;
    setRoute(`tools: ${role}`);
    addMessage({ role: 'user', text: `/edit ${instruction}` });
    setStatus('editing');
    setScroll(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const result = await deps.runAgent({
        instruction,
        files: filesRef.current,
        model: editModel,
        voice,
        facts: memory?.getFacts(sessionRef.current.project) ?? [],
        signal: controller.signal,
        onEvent: (e) => info(`→ ${e.name} ${e.summary}${e.ok ? '' : `  ✖ ${e.error}`}`),
      });
      if (result.answer) addMessage({ role: 'assistant', text: fixNotChecked(result.answer), state: 'done' });
      if (result.proposals.length === 0) {
        info(result.fallback ? 'This model cannot use file tools; no change was proposed.' : 'No change proposed.');
        setStatus('ready');
      } else {
        setReview({ proposals: result.proposals, index: 0, scroll: 0 });
        setStatus('review');
      }
    } catch (err) {
      if (err instanceof LlmError && err.code === 'ABORTED') {
        info('[stopped — nothing was written]');
        setStatus('stopped');
      } else {
        info(err.message, 'error');
        setStatus('error');
      }
    } finally {
      controllerRef.current = null;
    }
  }

  function decideEdit(approved) {
    const { proposals, index } = review;
    const proposal = proposals[index];
    if (approved) {
      const written = filesRef.current.applyEdit(proposal.path, proposal.newContent, {
        confirmed: true,
        baseHash: proposal.baseHash,
      });
      if (written.ok) info(`✔ Wrote ${written.absolutePath} (${written.bytes} bytes)`);
      else info(`Not written: ${written.error}`, 'error');
    } else {
      info(`Not applied: ${proposal.absolutePath}`);
    }
    if (index + 1 < proposals.length) {
      setReview({ proposals, index: index + 1, scroll: 0 });
    } else {
      setReview(null);
      setStatus('ready');
    }
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
    const rest = commandLine.slice(1).trim().slice(name.length).trim(); // text after the command
    if (busy && !['help', 'quit'].includes(name)) {
      info('Busy — press Esc to stop the reply first.', 'error');
      return;
    }
    switch (name) {
      case 'help':
        info(HELP_TEXT);
        break;
      case 'new':
      case 'clear':
        startNewConversation();
        break;
      case 'history':
        showHistory();
        break;
      case 'remember':
        rememberFact(rest);
        break;
      case 'facts':
        showFacts();
        break;
      case 'edit':
        runEdit(rest);
        break;
      case 'model':
        switchModel(args[0]);
        break;
      case 'auto':
        enableAuto();
        break;
      case 'voice':
        switchVoice(args[0]);
        break;
      case 'models':
        refreshInstalled();
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
    // Reviewing a proposed edit: only y / n / scrolling. Nothing else can write.
    if (review) {
      const lines = review.proposals[review.index].diff.split('\n').length;
      const scrollTo = (n) => setReview((r) => ({ ...r, scroll: Math.max(0, Math.min(n, lines - 1)) }));
      if (typed === 'y' || typed === 'Y') decideEdit(true);
      else if (typed === 'n' || typed === 'N' || key.escape || key.return) decideEdit(false);
      else if (typed === 'j' || key.downArrow) scrollTo(review.scroll + 1);
      else if (typed === 'k' || key.upArrow) scrollTo(review.scroll - 1);
      else if (key.pageDown) scrollTo(review.scroll + 10);
      else if (key.pageUp) scrollTo(review.scroll - 10);
      else if (typed === 'g') scrollTo(0);
      else if (typed === 'G') scrollTo(lines);
      return;
    }

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
      <${Header} role=${activeRole} auto=${!manualRole} model=${model} mode=${config.aiMode} voice=${voice} folder=${folder} />
      ${review
        ? html`<${DiffPanel}
            proposal=${review.proposals[review.index]}
            index=${review.index}
            total=${review.proposals.length}
            scroll=${review.scroll}
            height=${height - 4}
          />`
        : html`
          <${Box} ref=${viewportRef} flexGrow=${1} flexDirection="column" overflow="hidden" contentOffsetY=${top}>
            <${Box} ref=${contentRef} flexDirection="column" flexShrink=${0} paddingX=${1}>
              ${messages.length === 0
                ? html`<${Box} marginTop=${1}><${Text} dimColor>Ask me anything about ${folder}. Type /help for commands.<//><//>`
                : messages.map((m) => html`<${Message} key=${m.id} message=${m} />`)}
            <//>
          <//>`}
      <${StatusBar} mode=${mode} status=${status} stats=${stats} route=${route} columns=${columns > 0 ? columns : 80} />
      <${InputLine} mode=${mode} input=${input} cmdline=${cmdline} busy=${busy} reviewing=${Boolean(review)} />
    <//>`;
}
