// The IDE (WP-40): one page for a person and an agent. Projects (OPFS) with a file tree, an
// editor that saves into the project, Check / Build / Run / Test / Clippy / Format, dependencies
// from crates.io, a test panel that reruns one test, problems as editor markers, and the build's
// timings. Every action, the person's buttons and the agent's calls alike, goes through the same
// tool layer (web/agent/tools.ts): one queue per project and one log (Activity). Opened by the
// relay (tools/relay) as /ide.html?token=…, the page also takes the agent's calls over a
// WebSocket. Without a token it's the IDE alone. Run differs for a person: the program runs
// here, with the terminal as its stdin.
import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { rust } from '@codemirror/lang-rust';
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import { OrchestratorClient } from '../web/orchestrator/client';
import { AgentTools, type BuildStats, TOOL_NAMES, ToolError } from '../web/agent/tools';
import { runSandboxed, type SandboxHandle } from '../web/sandbox/sandbox';
import { Term } from './terminal';
import { SAMPLE, SAMPLE_NAME } from './sample';

declare const __RELEASE__: string;

const here = (f: string) => new URL(f, location.href).href;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string) => { $('status').textContent = s; };
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const token = new URLSearchParams(location.search).get('token');
const STORE = 'rust-ide:last';

// --- state
let project = '', file = '', calls = 0, saving: ReturnType<typeof setTimeout> | undefined, settingDoc = false;
let program: SandboxHandle | null = null;
const MARK_CALLS = 5;
const changedAt = new Map<string, number>();
let diagnostics: any[] = [];
let testResults: any = null;
const totals = { calls: 0, builds: 0, buildMs: 0 };

// --- editor and terminal
const view = new EditorView({
  parent: $('editor'),
  extensions: [
    basicSetup, rust(), oneDark, lintGutter(),
    keymap.of([
      { key: 'Mod-s', run: () => { void act('cargo_check'); return true; } },
      { key: 'Mod-Enter', run: () => { void run(); return true; } },
    ]),
    EditorView.updateListener.of(u => { if (u.docChanged && !settingDoc) scheduleSave(); }),
  ],
});
const term = new Term($('terminal'));

const orch = new OrchestratorClient(here('orchestrator-worker.js'));
const ready = orch.call('init', {
  releaseUrl: here(`/release/${__RELEASE__}/`), vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'), workers: 4, persist: true,
}).then(async r => {
  status(`Ready: rustc ${r.rustcId}, toolchain in ${fmtMs(r.ms)}`);
  let last = '';
  try { last = localStorage.getItem(STORE) ?? ''; } catch { /* storage blocked */ }
  await refreshProjects(last);
  return r;
}, e => { status('The toolchain failed to load'); term.write(`\x1b[31m${String(e)}\x1b[0m\r\n`); throw e; });

// --- the tool layer, shared by the buttons and the agent
const tools = new AgentTools(orch, {
  resolverUrl: here('resolver.wasm'), index: new URL('/index/', location.href).href,
  onFile(p, path, content, change) {
    if (change === 'write') changedAt.set(`${p}/${path}`, calls);
    // An agent's change to the open file shows at once; reads open the file to follow along.
    if (p !== project) void select(p);
    if (p === project && (path === file || change === 'read' || !file)) showFile(path, content);
  },
  onOutput(title, text) {
    term.clear();
    term.write(`\x1b[2m${title}\x1b[0m\r\n${text.replace(/\n/g, '\r\n')}`);
  },
  onBuild: showStats,
  onUnit(_tool, _p, u) {
    work.done++;
    if (!u.cached) work.built++;
    work.running.delete(`${u.name} ${u.kind}`);
    work.phase = 'compile';
    showWork();
  },
  onEvent(_tool, _p, e) {
    if (e.phase === 'start') work.running.add(`${e.name} ${e.kind}`);
    else if (e.phase === 'build') { work.planned = e.units; work.phase = 'compile'; }
    else work.phase = e.phase;
    if (e.phase === 'resolve') work.detail = `round ${e.round}, ${e.files} index file(s)`;
    if (e.phase === 'download') work.detail = `${e.done}/${e.total} ${e.cached ? 'from the cache' : 'downloaded'}, last ${e.name}`;
    if (e.phase === 'test') work.detail = `${e.done}/${e.total}, last ${e.name}`;
    showWork();
  },
});

// --- "it's working": the bar, the spinner on the button that started it, and the phase line
const BUTTONS: Record<string, string> = { cargo_check: 'check', cargo_build: 'build', cargo_run: 'run', cargo_test: 'test', cargo_clippy: 'clippy', cargo_fmt: 'fmt', dependency_add: 'dep' };
const ACTIONS = ['new', 'sample', 'import', 'export', 'delete', 'check', 'build', 'run', 'test', 'clippy', 'fmt', 'dep', 'newfile'];
const work = { who: '', tool: '', t0: 0, phase: '', detail: '', planned: 0, done: 0, built: 0, running: new Set<string>(), active: 0, button: '' };
let ticker: ReturnType<typeof setInterval> | undefined;

function startWork(who: string, tool: string, button?: string) {
  Object.assign(work, { who, tool, t0: performance.now(), phase: '', detail: '', planned: 0, done: 0, built: 0, button: button ?? BUTTONS[tool] ?? '' });
  work.running.clear();
  work.active++;
  // Quick calls (a file write) shouldn't flicker: the bar shows after 150 ms.
  setTimeout(() => { if (work.active) $('busybar').hidden = false; }, 150);
  for (const id of ACTIONS) $<HTMLButtonElement>(id).disabled = true;
  if (work.button) $(work.button).classList.add('busy');
  clearInterval(ticker);
  ticker = setInterval(showWork, 250);
  showWork();
}

function endWork() {
  if (--work.active > 0) return;
  work.active = 0;
  clearInterval(ticker);
  $('busybar').hidden = true;
  for (const id of ACTIONS) $<HTMLButtonElement>(id).disabled = false;
  for (const b of document.querySelectorAll('button.busy')) b.classList.remove('busy');
  $('progress').textContent = '';
}

function showWork() {
  if (!work.active) return;
  const s = ((performance.now() - work.t0) / 1000).toFixed(1);
  const what = work.phase === 'resolve' ? `resolving dependencies (${work.detail})`
    : work.phase === 'download' ? `fetching crates (${work.detail})`
    : work.phase === 'plan' ? 'planning the build'
    : work.phase === 'compile' ? `compiling: ${work.done}/${work.planned || '?'} units ready (${work.built} built)${work.running.size ? `, now ${[...work.running].slice(0, 3).join(', ')}${work.running.size > 3 ? ` +${work.running.size - 3}` : ''}` : ''}`
    : work.phase === 'test' ? `running tests (${work.detail})`
    : 'working';
  $('progress').textContent = `${work.who === 'agent' ? 'agent · ' : ''}${work.tool.replace('cargo_', '')} ${s} s · ${what}`;
}

/**
 * Runs tool `name` for `who` (the person or the agent), logged in Activity, and updates the panels
 * from its result. The tool layer queues it behind other calls on the same project.
 */
async function call(who: 'you' | 'agent', name: string, args: Record<string, any>, button?: string): Promise<any> {
  calls++;
  totals.calls++;
  showTotals();
  const row = logCall(who, name, args);
  startWork(who, name, button);
  const t0 = performance.now();
  status(`${who === 'agent' ? 'Agent: ' : ''}${name}…`);
  try {
    const r: any = await tools.call(name, args);
    row(true, summarize(r), performance.now() - t0);
    afterResult(name, args, r);
    return r;
  } catch (e) {
    const msg = e instanceof ToolError ? e.message : `internal error: ${String((e as Error)?.message ?? e)}`;
    row(false, msg, performance.now() - t0);
    throw e instanceof ToolError ? e : new ToolError(msg);
  } finally {
    endWork();
    status(`Idle · ${calls} call(s)`);
    void refreshTree();
  }
}

/** The person's buttons: a tool on the current project, errors shown, not thrown. `button`: the one to spin. */
async function act(name: string, args: Record<string, any> = {}, button?: string) {
  await ready;
  if (!project && name !== 'project_create') { status('No project: New or Sample first'); return; }
  await flushSave();
  try { return await call('you', name, { project, ...args }, button); } catch { /* in Activity */ return undefined; }
}

function afterResult(name: string, args: Record<string, any>, r: any) {
  if (Array.isArray(r?.diagnostics)) {
    diagnostics = r.diagnostics;
    renderProblems();
    if (r.errors) tab('problems');
  }
  if (name === 'cargo_test') {
    if (r.tests) {
      // A rerun of one test updates that row; a full run replaces the list.
      if (args.filter && args.exact && testResults?.tests) {
        for (const t of r.tests) {
          const i = testResults.tests.findIndex((x: any) => x.suite === t.suite && x.name === t.name);
          if (i >= 0) testResults.tests[i] = t; else testResults.tests.push(t);
        }
      } else testResults = r;
      renderTests();
      tab('tests');
    } else if (r.diagnostics) tab('problems');
  }
  if (name === 'cargo_fmt' && file) void reopen();
  if (name === 'project_create') void refreshProjects(args.project, true);
  if (name === 'project_delete') void refreshProjects('');
  if (name.startsWith('dependency_') && r?.ok && file === 'Cargo.toml') void reopen();
}

// --- projects and files

/** `force`: reopen `pick` even if it's open (it was just created or replaced). */
async function refreshProjects(pick = project, force = false) {
  const list: string[] = await orch.call('projectList', {});
  const sel = $<HTMLSelectElement>('project');
  sel.replaceChildren(...list.map(p => new Option(p, p)));
  if (!list.length) {
    sel.append(new Option('(no projects)', ''));
    project = file = '';
    showFile('', '');
    await refreshTree();
    return;
  }
  await select(list.includes(pick) ? pick : list.includes(project) ? project : list[0], force);
}

async function select(p: string, force = false) {
  if (p === project && file && !force) { await refreshTree(); return; }
  project = p;
  $<HTMLSelectElement>('project').value = p;
  try { localStorage.setItem(STORE, p); } catch { /* storage blocked */ }
  diagnostics = [];
  testResults = null;
  renderProblems();
  renderTests();
  const files = await listFiles();
  file = '';
  const first = ['README.md', 'src/main.rs', 'src/lib.rs'].find(f => files.includes(f)) ?? files.find(f => f.endsWith('.rs')) ?? files[0];
  if (first) await open(first); else showFile('', '');
  await refreshTree();
}

const listFiles = () => (project ? orch.call('listFiles', { dir: `/projects/${project}` }) : Promise.resolve([] as string[]));
const read = async (path: string) => new TextDecoder().decode(await orch.call('readFile', { path: `/projects/${project}/${path}` }));

async function open(path: string) {
  await flushSave();
  showFile(path, await read(path));
}

async function reopen() {
  if (file) showFile(file, await read(file).catch(() => ''));
}

function showFile(path: string, content: string) {
  file = path;
  $('file-title').textContent = path ? `${project}/${path}` : 'No file open';
  settingDoc = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  settingDoc = false;
  markers();
  for (const el of document.querySelectorAll<HTMLElement>('#tree .file')) el.classList.toggle('open', el.dataset.path === path);
}

function scheduleSave() {
  clearTimeout(saving);
  if (!project || !file) return;
  const p = project, f = file;
  saving = setTimeout(() => { saving = undefined; void orch.call('writeFile', { path: `/projects/${p}/${f}`, data: view.state.doc.toString() }); }, 400);
}

/** Pending editor changes into the project, before anything builds. */
async function flushSave() {
  if (saving === undefined) return;
  clearTimeout(saving);
  saving = undefined;
  if (project && file) await orch.call('writeFile', { path: `/projects/${project}/${file}`, data: view.state.doc.toString() });
}

async function refreshTree() {
  const tree = $('tree');
  const files = await listFiles().catch(() => [] as string[]);
  tree.replaceChildren();
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
      tree.append(el);
    }
    lastDir = dirs;
    const el = document.createElement('div');
    el.className = 'file';
    el.dataset.path = f;
    el.style.setProperty('--depth', String(dirs.length));
    el.innerHTML = `<span class="name"></span><span class="ops"><span data-op="rename" title="Rename">✎</span><span data-op="delete" title="Delete">✕</span></span>`;
    el.querySelector('.name')!.textContent = parts.at(-1)!;
    el.classList.toggle('touched', (changedAt.get(`${project}/${f}`) ?? -Infinity) > calls - MARK_CALLS);
    el.classList.toggle('open', f === file);
    el.onclick = async e => {
      const op = (e.target as HTMLElement).dataset.op;
      if (op === 'delete') { if (confirm(`Delete ${f}?`)) { await act('file_delete', { path: f }); if (f === file) showFile('', ''); } return; }
      if (op === 'rename') { const to = prompt('Rename to', f); if (to && to !== f) await rename(f, to); return; }
      await open(f);
    };
    tree.append(el);
  }
}

async function rename(from: string, to: string) {
  const content = await read(from);
  if (await act('file_write', { path: to, content }) && await act('file_delete', { path: from })) {
    if (file === from) showFile(to, content);
  }
}

// --- panels

function tab(name: string) {
  for (const b of document.querySelectorAll<HTMLElement>('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const t of document.querySelectorAll<HTMLElement>('.tab')) t.classList.toggle('on', t.id === name);
}
for (const b of document.querySelectorAll<HTMLElement>('.tabs button')) b.onclick = () => tab(b.dataset.tab!);

function renderProblems() {
  const el = $('problems');
  const shown = diagnostics.filter(d => d.level === 'error' || d.level === 'warning');
  $('problems-count').textContent = shown.length ? `(${shown.length})` : '';
  if (!shown.length) { el.innerHTML = '<div class="empty">No problems.</div>'; markers(); return; }
  el.replaceChildren(...shown.map(d => {
    const row = document.createElement('div');
    row.className = `row ${d.level}`;
    row.innerHTML = `<span class="lvl">${d.level}</span>${d.code ? ` <span class="muted">${esc(d.code)}</span>` : ''} ${esc(d.message)}<br><span class="muted">${esc(d.file ?? '')}${d.line ? `:${d.line}:${d.column}` : ''}</span>`;
    row.title = d.rendered;
    row.onclick = async () => {
      if (!d.file) return;
      if (d.file !== file) await open(d.file);
      const line = view.state.doc.line(Math.min(d.line, view.state.doc.lines));
      view.dispatch({ selection: { anchor: Math.min(line.from + d.column - 1, line.to) }, scrollIntoView: true });
      view.focus();
    };
    return row;
  }));
  markers();
}

/** The open file's diagnostics as editor markers. */
function markers() {
  const doc = view.state.doc;
  const pos = (line: number, col: number) => { const l = doc.line(Math.max(1, Math.min(line, doc.lines))); return Math.min(l.from + Math.max(0, col - 1), l.to); };
  const ds: CmDiagnostic[] = diagnostics.filter(d => d.file === file && d.line && (d.level === 'error' || d.level === 'warning')).map(d => {
    const from = pos(d.line, d.column);
    const to = Math.max(from, d.end_line ? pos(d.end_line, d.end_column) : from);
    return { from, to, severity: d.level as 'error' | 'warning', message: `${d.code ? `${d.code}: ` : ''}${d.message}` };
  });
  view.dispatch(setDiagnostics(view.state, ds));
}

function renderTests() {
  const el = $('tests');
  if (!testResults?.tests) {
    $('tests-count').textContent = '';
    el.innerHTML = '<div class="empty">Run the tests (Test).</div>';
    return;
  }
  const ts = testResults.tests;
  const failed = ts.filter((t: any) => t.status === 'failed').length;
  $('tests-count').textContent = `(${ts.length - failed}/${ts.length})`;
  const head = document.createElement('div');
  head.className = 'suite';
  head.innerHTML = `${ts.filter((t: any) => t.status === 'ok').length} passed, ${failed} failed, ${ts.filter((t: any) => t.status === 'ignored').length} ignored <button>Run all</button>`;
  head.querySelector('button')!.onclick = () => void act('cargo_test');
  const rows: HTMLElement[] = [head];
  let suite = '';
  for (const t of ts) {
    if (t.suite !== suite) {
      suite = t.suite;
      const s = document.createElement('div');
      s.className = 'suite';
      s.textContent = suite;
      rows.push(s);
    }
    const row = document.createElement('div');
    row.className = `row ${t.status}`;
    const icon = t.status === 'ok' ? '✓' : t.status === 'failed' ? '✗' : '–';
    row.innerHTML = `<button>Rerun</button><span class="lvl">${icon}</span> ${esc(t.name)} <span class="muted">${t.ms} ms${t.ignored ? ` · ${esc(t.ignored)}` : ''}</span>`;
    const detail = [t.message, t.stdout].filter(Boolean).join('\n');
    if (detail) {
      const pre = document.createElement('pre');
      pre.textContent = detail;
      pre.hidden = t.status !== 'failed';
      row.append(pre);
      row.onclick = e => { if ((e.target as HTMLElement).tagName !== 'BUTTON') pre.hidden = !pre.hidden; };
    }
    row.querySelector('button')!.onclick = () => void act('cargo_test', { filter: t.name, exact: true });
    rows.push(row);
  }
  el.replaceChildren(...rows);
}

function logCall(who: 'you' | 'agent', name: string, args: Record<string, unknown>) {
  const row = document.createElement('div');
  row.className = 'row';
  const shown = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'project')
    .map(([k, v]) => [k, typeof v === 'string' && v.length > 80 ? `${v.slice(0, 80)}… (${v.length} chars)` : v]));
  row.innerHTML = `<span class="who ${who}">${who}</span><span class="name"></span> <span class="muted ms">…</span><div class="muted args"></div><div class="res"></div>`;
  row.querySelector('.name')!.textContent = name;
  row.querySelector('.args')!.textContent = Object.keys(shown).length ? JSON.stringify(shown) : '';
  $('activity').prepend(row);
  return (ok: boolean, summary: string, ms: number) => {
    if (!ok) row.classList.add('err');
    row.querySelector('.ms')!.textContent = fmtMs(ms);
    row.querySelector('.res')!.textContent = summary;
  };
}

/** One line for the log: ok/errors/tests, whatever the result has. */
function summarize(r: any): string {
  if (!r || typeof r !== 'object') return String(r);
  const parts: string[] = [];
  if ('ok' in r) parts.push(r.ok ? 'ok' : 'failed');
  if (typeof r.errors === 'number' && r.errors) parts.push(`${r.errors} error(s)`);
  if (typeof r.warnings === 'number' && r.warnings) parts.push(`${r.warnings} warning(s)`);
  if (r.counts) parts.push(`${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.ignored} ignored`);
  if ('exit_code' in r) parts.push(`exit ${r.exit_code}`);
  if (Array.isArray(r.unformatted)) parts.push(r.unformatted.length ? `unformatted: ${r.unformatted.map((u: any) => u.path).join(', ')}` : 'all formatted');
  if (Array.isArray(r.changed)) parts.push(r.changed.length ? `formatted: ${r.changed.join(', ')}` : 'nothing to change');
  if (r.error) parts.push(String(r.error).split('\n')[0]);
  if (Array.isArray(r.files)) parts.push(`${r.files.length} file(s)`);
  if (r.changes) parts.push(`${r.changes.length} lockfile change(s)`);
  return parts.join(', ') || JSON.stringify(r).slice(0, 200);
}

function showStats(s: BuildStats) {
  totals.builds++;
  totals.buildMs += s.ms.total;
  const cached = s.fresh + s.l1 + s.l2;
  const extra = Object.entries(s.extra ?? {}).map(([k, v]) => `<span class="k">${k}</span> ${fmtMs(v)}`).join(' · ');
  $('stats').innerHTML = `<b>${s.tool.replace('cargo_', '')}</b> ${esc(s.project)}: ${s.ok ? '' : '<span class="bad">failed</span> '}${fmtMs(s.ms.total)}`
    + ` · <span class="k">deps</span> ${fmtMs(s.ms.deps)} · <span class="k">plan</span> ${fmtMs(s.ms.plan)} · <span class="k">build</span> ${fmtMs(s.ms.build)}`
    + ` · <span class="k">units</span> ${s.units} (${s.built} built, ${cached} cached) · <span class="k">own rustc</span> ${fmtMs(s.ownRustcMs)}`
    + (extra ? ` · ${extra}` : '');
  $('stats').title = `cached: ${s.fresh} in memory, ${s.l1} from L1 (OPFS), ${s.l2} from L2`;
  showTotals();
}

function showTotals() {
  $('totals').textContent = `${totals.calls} call(s), ${totals.builds} build(s), ${fmtMs(totals.buildMs)} building`;
}

// --- Run, for a person: the program in the sandbox here, the terminal as its stdin

async function run() {
  if (program) return;
  const r = await act('cargo_build', {}, 'run');
  if (!r) return;
  if (!r.ok) { tab('problems'); return; }
  const bin = r.bins.length === 1 ? r.bins[0] : r.bins.includes(project) ? project : r.bins[0];
  if (!bin) { status('No executable (src/main.rs or [[bin]])'); return; }
  const wasm = await orch.call('readFile', { path: `/target/wasm32-wasip1/debug/${bin}.wasm` });
  const files: Record<string, Uint8Array> = {};
  for (const f of await listFiles()) files[`/projects/${project}/${f}`] = await orch.call('readFile', { path: `/projects/${project}/${f}` });
  term.clear();
  tab('terminal');
  status(`Running ${bin}… (type input, Ctrl-D ends it, Ctrl-C stops)`);
  program = runSandboxed({
    workerUrl: here('sandbox-worker.js'), vfsUrl: here('vfs.wasm'), program: wasm, args: [bin], interactive: true, files,
    onStdout: d => term.write(d), onStderr: d => term.write(d),
  });
  term.attach(program);
  $<HTMLButtonElement>('stop').disabled = false;
  const res = await program.result;
  term.detach();
  program = null;
  $<HTMLButtonElement>('stop').disabled = true;
  const how = res.killed ? (res.timedOut ? 'timed out' : 'stopped') : res.code === 0 ? 'exited' : `exited with code ${res.code}`;
  term.write(`\r\n\x1b[2m[${bin} ${how} after ${(res.ms / 1000).toFixed(2)} s]\x1b[0m\r\n`);
  status(`${bin} ${how}`);
}

// --- buttons

$('project').onchange = () => void select($<HTMLSelectElement>('project').value);
$('new').onclick = async () => {
  const name = prompt('New project (letters, digits, - and _)', 'hello');
  if (name) await act('project_create', { project: name });
};
$('sample').onclick = async () => {
  await ready;
  const exists = (await orch.call('projectList', {})).includes(SAMPLE_NAME);
  if (exists && !confirm(`Replace the project "${SAMPLE_NAME}" with a fresh copy?`)) return select(SAMPLE_NAME);
  if (await act('project_create', { project: SAMPLE_NAME, files: SAMPLE, overwrite: true })) await open('README.md');
};
$('import').onclick = async () => {
  const what = prompt('Import: "owner/repo" or "owner/repo/sub/dir" from GitHub, or leave empty to pick a .zip file', '');
  if (what === null) return;
  if (!what.trim()) { $('zipfile').click(); return; }
  const [owner, repo, ...sub] = what.trim().split('/');
  const name = prompt('Project name', repo) ?? '';
  if (!name) return;
  await ready;
  const t0 = performance.now();
  try {
    const r = await orch.call('projectImport', { name, source: { github: `${owner}/${repo}`, subdir: sub.join('/') || undefined } });
    status(`Imported ${r.files} file(s) in ${fmtMs(performance.now() - t0)}`);
    await refreshProjects(name);
  } catch (e) { status(`Import failed: ${String((e as Error).message).split('\n')[0]}`); }
};
$<HTMLInputElement>('zipfile').onchange = async () => {
  const f = $<HTMLInputElement>('zipfile').files?.[0];
  if (!f) return;
  const name = prompt('Project name', f.name.replace(/\.zip$/i, '').replace(/[^A-Za-z0-9_-]/g, '-')) ?? '';
  $<HTMLInputElement>('zipfile').value = '';
  if (!name) return;
  try {
    const r = await orch.call('projectImport', { name, source: { zip: new Uint8Array(await f.arrayBuffer()) } });
    status(`Imported ${r.files} file(s)`);
    await refreshProjects(name);
  } catch (e) { status(`Import failed: ${String((e as Error).message).split('\n')[0]}`); }
};
$('export').onclick = async () => {
  if (!project) return;
  const zip = await orch.call('projectExport', { name: project });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
  a.download = `${project}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
};
$('delete').onclick = async () => {
  if (project && confirm(`Delete the project "${project}" and all its files?`)) await act('project_delete');
};
$('newfile').onclick = async () => {
  const path = prompt('New file (path in the project)', 'src/');
  if (path && !path.endsWith('/') && await act('file_write', { path, content: '' })) await open(path);
};
$('check').onclick = () => void act('cargo_check');
$('build').onclick = () => void act('cargo_build');
$('run').onclick = () => void run();
$('stop').onclick = () => program?.kill();
$('test').onclick = () => void act('cargo_test');
$('clippy').onclick = () => void act('cargo_clippy');
$('fmt').onclick = () => void act('cargo_fmt');
$('dep').onclick = async () => {
  const spec = prompt('Dependency: name, optionally @version and features, e.g. "itoa", "serde@1 derive"', '');
  if (!spec?.trim()) return;
  const [nameVer, ...features] = spec.trim().split(/\s+/);
  const [name, version] = nameVer.split('@');
  await act('dependency_add', { name, ...(version && { version }), ...(features.length && { features }) });
};

// --- the agent, through the relay

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay?token=${encodeURIComponent(token!)}`);
  ws.onopen = async () => {
    $('relay').textContent = 'agent: connected';
    $('relay').classList.add('on');
    const r = await ready.catch(() => null);
    ws.send(JSON.stringify({ type: 'hello', tools: TOOL_NAMES, rustcId: r?.rustcId ?? null }));
  };
  ws.onmessage = async e => {
    const m = JSON.parse(e.data);
    if (m.type !== 'call') return;
    try {
      await ready;
      const result = await call('agent', m.tool, m.args ?? {});
      ws.send(JSON.stringify({ type: 'result', id: m.id, result }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', id: m.id, error: (err as Error).message, tool_error: err instanceof ToolError }));
    }
  };
  ws.onclose = () => {
    $('relay').textContent = 'agent: disconnected, retrying…';
    $('relay').classList.remove('on');
    setTimeout(connect, 1000);
  };
}

if (token) { $('relay').hidden = false; connect(); }

// For tests (tests/e2e/ide.spec.ts) and the relay's scenario.
(window as any).ide = { tools, orch, ready, view, term, act, run, select, open, project: () => project, file: () => file, busy: () => !!program, connected: () => $('relay').classList.contains('on') };
