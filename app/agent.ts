// The IDE page an agent drives (WP-38): opened by the relay (tools/relay/relay.py) as
// /agent.html?token=<per-run token>, it connects back over a WebSocket, runs each tool call with
// web/agent/tools.ts on the orchestrator, and answers with the JSON result. A person can watch:
// the projects' files on the left (files the last call changed are marked; click one to see it),
// every call with its arguments, time and a short result, the file a tool read or wrote in the
// editor, program and test output in the terminal, and the last build's timings in the top bar.
// After a reload or a lost connection the page connects again; projects survive in OPFS.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { rust } from '@codemirror/lang-rust';
import { oneDark } from '@codemirror/theme-one-dark';
import { OrchestratorClient } from '../web/orchestrator/client';
import { AgentTools, type BuildStats, TOOL_NAMES, ToolError } from '../web/agent/tools';
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
}).then(r => {
  status(`Ready: rustc ${r.rustcId}, ${r.projects?.names.length ?? 0} project(s), toolchain in ${fmt(r.ms)}`);
  void refreshTree();
  return r;
},
  e => { status('The toolchain failed to load'); throw e; });

function show(project: string, path: string, content: string) {
  shown = `${project}/${path}`;
  $('file-title').textContent = shown;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  for (const el of document.querySelectorAll('#tree .file')) el.classList.toggle('open', (el as HTMLElement).dataset.path === shown);
}

// --- the file tree: every project, refreshed after each call; what the last few calls changed
// is marked.
let shown = '', active = '', calls = 0;
const MARK_CALLS = 5;
const changedAt = new Map<string, number>();
const touched = { has: (f: string) => (changedAt.get(f) ?? -Infinity) > calls - MARK_CALLS };

async function refreshTree() {
  const tree = $('tree');
  const projects = await orch.call('projectList', {}).catch(() => [] as string[]);
  if (!projects.length) { tree.innerHTML = '<div class="empty">No projects yet</div>'; return; }
  const open = new Set([...tree.querySelectorAll('details[open]')].map(d => (d as HTMLElement).dataset.project));
  tree.replaceChildren();
  for (const p of projects) {
    const files = await orch.call('listFiles', { dir: `/projects/${p}` }).catch(() => [] as string[]);
    const d = document.createElement('details');
    d.dataset.project = p;
    d.open = open.has(p) || p === active || projects.length === 1;
    const sum = document.createElement('summary');
    sum.textContent = `${p}  (${files.length})`;
    d.append(sum);
    let lastDir: string[] = [];
    for (const f of files) {
      const parts = f.split('/'), dirs = parts.slice(0, -1);
      // The list is sorted: a line for each directory from where this path leaves the last one's.
      let k = 0;
      while (k < dirs.length && k < lastDir.length && dirs[k] === lastDir[k]) k++;
      for (let i = k; i < dirs.length; i++) {
        const el = document.createElement('div');
        el.className = 'dir';
        el.style.setProperty('--depth', String(i));
        el.textContent = `${dirs[i]}/`;
        d.append(el);
      }
      lastDir = dirs;
      const el = document.createElement('div');
      el.className = 'file';
      el.style.setProperty('--depth', String(dirs.length));
      el.dataset.path = `${p}/${f}`;
      el.textContent = parts.at(-1)!;
      el.classList.toggle('touched', touched.has(`${p}/${f}`));
      el.classList.toggle('open', shown === `${p}/${f}`);
      el.onclick = async () => show(p, f, new TextDecoder().decode(await orch.call('readFile', { path: `/projects/${p}/${f}` })));
      d.append(el);
    }
    tree.append(d);
  }
}

// --- the stats bar: the last build's phases and units, and totals for this page.
const totals = { calls: 0, builds: 0, buildMs: 0, toolMs: 0 };
const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

function showStats(s: BuildStats) {
  totals.builds++;
  totals.buildMs += s.ms.total;
  const cached = s.fresh + s.l1 + s.l2;
  const extra = Object.entries(s.extra ?? {}).map(([k, v]) => `<span class="k">${k}</span> ${fmt(v)}`).join(' · ');
  $('stats').innerHTML = `<b>${s.tool.replace('cargo_', '')}</b> ${s.project}: ${s.ok ? '' : '<span class="bad">failed</span> '}${fmt(s.ms.total)}`
    + ` · <span class="k">deps</span> ${fmt(s.ms.deps)} · <span class="k">plan</span> ${fmt(s.ms.plan)} · <span class="k">build</span> ${fmt(s.ms.build)}`
    + ` · <span class="k">units</span> ${s.units} (${s.built} built, ${cached} cached) · <span class="k">own rustc</span> ${fmt(s.ownRustcMs)}`
    + (extra ? ` · ${extra}` : '');
  $('stats').title = `cached: ${s.fresh} in memory, ${s.l1} from L1 (OPFS), ${s.l2} from L2`;
  showTotals();
}

function showTotals() {
  $('totals').textContent = `${totals.calls} call(s), ${totals.builds} build(s), ${fmt(totals.buildMs)} building`;
}

const tools = new AgentTools(orch, {
  resolverUrl: here('resolver.wasm'), index: new URL('/index/', location.href).href,
  onFile(project, path, content, change) {
    active = project;
    if (change === 'write') changedAt.set(`${project}/${path}`, calls);
    show(project, path, content);
  },
  onBuild: showStats,
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
  const t0 = performance.now();
  return (ok: boolean, summary: string) => {
    el.classList.remove('run');
    if (!ok) el.classList.add('err');
    const ms = document.createElement('span');
    ms.className = 'ms';
    ms.textContent = fmt(performance.now() - t0);
    el.querySelector('.name')!.append(ms);
    el.querySelector('.res')!.textContent = summary;
  };
}

/** One line for the log: ok/errors/tests, whatever the result has. */
function summarize(r: any): string {
  if (!r || typeof r !== 'object') return String(r);
  const parts: string[] = [];
  if ('ok' in r) parts.push(r.ok ? 'ok' : 'failed');
  if (typeof r.errors === 'number' && r.errors) parts.push(`${r.errors} error(s)`);
  if (typeof r.warnings === 'number' && r.warnings) parts.push(`${r.warnings} warning(s)`);
  // cargo_fmt: what it changed or found unformatted, and rustfmt's failures.
  if (Array.isArray(r.unformatted)) parts.push(r.unformatted.length ? `unformatted: ${r.unformatted.map((u: any) => u.path).join(', ')}` : 'all formatted');
  if (Array.isArray(r.changed)) parts.push(r.changed.length ? `formatted: ${r.changed.join(', ')}` : 'nothing to change');
  if (Array.isArray(r.errors) && r.errors.length) parts.push(`${r.errors.length} file(s) rustfmt couldn't format`);
  if (r.counts) parts.push(`${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.ignored} ignored`);
  if ('exit_code' in r) parts.push(`exit ${r.exit_code}`);
  if (r.error) parts.push(String(r.error).split('\n')[0]);
  if (r.files) parts.push(`${r.files.length} file(s)`);
  if (r.changes) parts.push(`${r.changes.length} lockfile change(s)`);
  return parts.join(', ') || JSON.stringify(r).slice(0, 200);
}

let socket: WebSocket | null = null;

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
    totals.calls++;
    showTotals();
    if (typeof m.args?.project === 'string') active = m.args.project;
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
      void refreshTree();
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
