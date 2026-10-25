// The IDE page an agent drives (WP-38): opened by the relay (tools/relay/relay.py) as
// /agent.html?token=<per-run token>, it connects back over a WebSocket, runs each tool call with
// web/agent/tools.ts on the orchestrator, and answers with the JSON result. A person can watch:
// every call is logged with its arguments and a short result, the file a tool read or wrote is
// shown in the editor, and program and test output go to the terminal. After a reload or a lost
// connection the page connects again; projects survive in OPFS.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { rust } from '@codemirror/lang-rust';
import { oneDark } from '@codemirror/theme-one-dark';
import { OrchestratorClient } from '../web/orchestrator/client';
import { AgentTools, TOOL_NAMES, ToolError } from '../web/agent/tools';
import { Term } from './terminal';

declare const __RELEASE__: string;

const here = (f: string) => new URL(f, location.href).href;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string) => { $('status').textContent = s; };
const token = new URLSearchParams(location.search).get('token') ?? '';

const view = new EditorView({ parent: $('editor'), extensions: [basicSetup, rust(), oneDark, EditorState.readOnly.of(true)] });
const term = new Term($('terminal'));

const orch = new OrchestratorClient(here('orchestrator-worker.js'));
const ready = orch.call('init', {
  releaseUrl: here(`/release/${__RELEASE__}/`), vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'), workers: 4, persist: true,
}).then(r => { status(`Ready: rustc ${r.rustcId}, ${r.projects?.names.length ?? 0} project(s)`); return r; },
  e => { status('The toolchain failed to load'); throw e; });

const tools = new AgentTools(orch, {
  resolverUrl: here('resolver.wasm'), index: new URL('/index/', location.href).href,
  onFile(project, path, content) {
    $('file-title').textContent = `${project}/${path}`;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  },
  onOutput(title, text) {
    $('out-title').textContent = title;
    term.clear();
    term.write(text.replace(/\n/g, '\r\n'));
  },
});

function logCall(tool: string, args: Record<string, unknown>) {
  const el = document.createElement('div');
  el.className = 'call run';
  const shown = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : v]));
  el.innerHTML = '<div class="name"></div><div class="args"></div><div class="res"></div>';
  el.querySelector('.name')!.textContent = tool;
  el.querySelector('.args')!.textContent = JSON.stringify(shown);
  $('log').append(el);
  el.scrollIntoView({ block: 'end' });
  return (ok: boolean, summary: string) => {
    el.classList.remove('run');
    if (!ok) el.classList.add('err');
    el.querySelector('.res')!.textContent = summary;
  };
}

/** One line for the log: ok/errors/tests, whatever the result has. */
function summarize(r: any): string {
  if (!r || typeof r !== 'object') return String(r);
  const parts: string[] = [];
  if ('ok' in r) parts.push(r.ok ? 'ok' : 'failed');
  if (r.errors) parts.push(`${r.errors} error(s)`);
  if (r.warnings) parts.push(`${r.warnings} warning(s)`);
  if (r.counts) parts.push(`${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.ignored} ignored`);
  if ('exit_code' in r) parts.push(`exit ${r.exit_code}`);
  if (r.error) parts.push(String(r.error).split('\n')[0]);
  if (r.files) parts.push(`${r.files.length} file(s)`);
  if (r.changes) parts.push(`${r.changes.length} lockfile change(s)`);
  return parts.join(', ') || JSON.stringify(r).slice(0, 200);
}

let socket: WebSocket | null = null;
let calls = 0;

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay?token=${encodeURIComponent(token)}`);
  socket = ws;
  ws.onopen = async () => {
    $('relay').textContent = 'relay: connected';
    $('relay').classList.add('on');
    const r = await ready.catch(() => null);
    ws.send(JSON.stringify({ type: 'hello', tools: TOOL_NAMES, rustcId: r?.rustcId ?? null }));
  };
  ws.onmessage = async e => {
    const m = JSON.parse(e.data);
    if (m.type !== 'call') return;
    calls++;
    const done = logCall(m.tool, m.args ?? {});
    try {
      await ready;
      status(`Running ${m.tool}…`);
      const result = await tools.call(m.tool, m.args ?? {});
      done(true, summarize(result));
      ws.send(JSON.stringify({ type: 'result', id: m.id, result }));
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `internal error: ${String((err as Error)?.message ?? err)}`;
      done(false, message);
      ws.send(JSON.stringify({ type: 'error', id: m.id, error: message, tool_error: err instanceof ToolError }));
    } finally {
      status(`Idle (${calls} call(s))`);
    }
  };
  ws.onclose = () => {
    $('relay').textContent = 'relay: disconnected, retrying…';
    $('relay').classList.remove('on');
    if (socket === ws) setTimeout(connect, 1000);
  };
}

if (token) connect();
else $('relay').textContent = 'relay: no token (open this page from tools/relay)';

// For tests (tests/e2e/agent.spec.ts).
(window as any).agent = { tools, orch, ready, connected: () => socket?.readyState === WebSocket.OPEN };
