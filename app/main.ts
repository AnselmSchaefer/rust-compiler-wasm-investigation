// The minimal IDE (WP-14, milestone M1a): editor first, then the toolchain in the background.
// Check = rustc --emit=metadata; Run = build + link through the orchestrator, then the program in
// the run sandbox with the terminal as its stdin/stdout.
import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { rust } from '@codemirror/lang-rust';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import { OrchestratorClient } from '../web/orchestrator/client';
import { runSandboxed, type SandboxHandle } from '../web/sandbox/sandbox';
import { parseRustcOutput } from './diagnostics';
import { Term } from './terminal';

declare const __RELEASE__: string; // RUSTC_ID of the bundled release (scripts/build-app.mjs)

const DEFAULT = `use std::io::{self, BufRead, Write};

fn main() {
    println!("Hello from Rust, compiled in your browser!");
    print!("What's your name? ");
    io::stdout().flush().unwrap();
    let mut name = String::new();
    io::stdin().lock().read_line(&mut name).unwrap();
    println!("Nice to meet you, {}!", name.trim());
}
`;
const FILE = '/work/main.rs';
const STORE = 'rust-ide:main.rs';
const here = (f: string) => new URL(f, location.href).href;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string) => { $('status').textContent = s; };

let source = DEFAULT;
try { source = localStorage.getItem(STORE) ?? DEFAULT; } catch { /* storage blocked */ }

const view = new EditorView({
  parent: $('editor'),
  doc: source,
  extensions: [
    basicSetup, rust(), oneDark, lintGutter(),
    keymap.of([
      { key: 'Mod-s', run: () => { void check(); return true; } },
      { key: 'Mod-Enter', run: () => { void run(); return true; } },
    ]),
    EditorView.updateListener.of(u => {
      if (!u.docChanged) return;
      try { localStorage.setItem(STORE, u.state.doc.toString()); } catch { /* storage blocked */ }
    }),
  ],
});
view.focus();
performance.mark('editor-ready');
const term = new Term($('terminal'));
status('Loading the Rust toolchain…');

// The toolchain loads after the editor is up.
const orch = new OrchestratorClient(here('orchestrator-worker.js'));
const ready = orch.call('init', {
  releaseUrl: here(`/release/${__RELEASE__}/`), vfsUrl: here('vfs.wasm'), workerUrl: here('process-worker.js'),
}).then(r => {
  status(`Ready: rustc ${r.rustcId} (${(r.ms / 1000).toFixed(1)} s)`);
  for (const b of ['check', 'run'] as const) $<HTMLButtonElement>(b).disabled = false;
  return r;
}, e => { status('The toolchain failed to load'); term.write(`\x1b[31m${String(e)}\x1b[0m\r\n`); throw e; });

let busy = false, program: SandboxHandle | null = null;
const c = ['--target', 'wasm32-wasip1', '--edition', '2021', '--error-format=json', '--json=diagnostic-rendered-ansi'];

async function compile(kind: 'check' | 'build') {
  const code = view.state.doc.toString();
  await orch.call('writeFile', { path: FILE, data: code });
  const args = kind === 'check' ? [FILE, ...c, '--emit=metadata', '-o', '/work/main.rmeta'] : [FILE, ...c, '-o', '/work/main.wasm'];
  const r = await orch.call('rustc', { args });
  const p = parseRustcOutput(r.stderr, FILE, code);
  view.dispatch(setDiagnostics(view.state, p.diagnostics));
  if (p.text) term.write(p.text);
  return { ok: r.code === 0, ms: r.ms.total, ...p };
}

async function check() {
  if (busy) return;
  busy = true;
  try {
    await ready;
    term.clear();
    status('Checking…');
    const r = await compile('check');
    const summary = r.ok ? `No errors${r.warnings ? `, ${r.warnings} warning(s)` : ''}` : r.errors ? `${r.errors} error(s)` : 'Check failed';
    term.write(`\x1b[2m${summary} (${r.ms} ms)\x1b[0m\r\n`);
    status(summary);
  } finally { busy = false; }
}

async function run() {
  if (busy) return;
  busy = true;
  try {
    await ready;
    term.clear();
    status('Building…');
    const r = await compile('build');
    if (!r.ok) { status(r.errors ? `${r.errors} error(s)` : 'Build failed'); return; }
    status(`Running (built in ${r.ms} ms)`);
    const wasm = await orch.call('readFile', { path: '/work/main.wasm' });
    program = runSandboxed({
      workerUrl: here('sandbox-worker.js'), vfsUrl: here('vfs.wasm'), program: wasm, args: ['main'], interactive: true,
      onStdout: d => term.write(d), onStderr: d => term.write(d),
    });
    term.attach(program);
    $<HTMLButtonElement>('stop').disabled = false;
    const res = await program.result;
    term.detach();
    const how = res.killed ? (res.timedOut ? 'timed out' : 'stopped') : res.code === 0 ? 'exited' : `exited with code ${res.code}`;
    term.write(`\r\n\x1b[2m[program ${how} after ${(res.ms / 1000).toFixed(2)} s]\x1b[0m\r\n`);
    status(`Program ${how}`);
  } finally {
    program = null;
    busy = false;
    $<HTMLButtonElement>('stop').disabled = true;
  }
}

$('check').onclick = () => void check();
$('run').onclick = () => void run();
$('stop').onclick = () => program?.kill();

// For tests and the bench (tests/e2e/app.spec.ts).
(window as any).ide = { view, term, ready, check, run, stop: () => program?.kill(), busy: () => busy };
