// `cargo test` and `cargo clippy` in the browser (WP-26), on top of cargoBuild.
//
// cargo test: the planner's test plan (dev-dependencies, examples, a `--test` harness per lib, bin
// and integration test), then each harness's tests. wasm32-wasip1 aborts on a panic, so a failing
// test would end its whole harness: like cargo's -Zpanic-abort-tests, every test runs in a
// process of its own (`<name> --exact`), up to `workers` at a time, after a `--list`. libtest's
// JSON events (unstable output: RUSTC_BOOTSTRAP=1 in the harness's environment, which stable
// libtest checks at run time) give status and time; the other lines are the test's own output
// (`--nocapture`, since an aborted test can't print what was captured). A panic's message comes
// from stderr. `#[should_panic]` tests can't run on an aborting target: libtest reports them as
// ignored, and so do we, with the reason.
//
// cargo clippy: a normal build (dependencies as they are, cached), then the primary packages'
// libs and bins checked again with `--emit=metadata` as Clippy (rustc-multi's tool mode), with
// their JSON diagnostics returned.

import type { Resolver } from '../deps/resolver';
import { type BuildHost, type BuildOptions, type BuildResult, cargoBuild } from './cargo';
import { type Diagnostic, parseDiagnostics } from './diagnostics';

export type { Diagnostic };

export type TestStatus = 'ok' | 'failed' | 'ignored';

export interface TestResult {
  /** The harness, as cargo names it: `unittests src/lib.rs`, `tests/integration.rs`. */
  suite: string;
  package: string;
  name: string;
  status: TestStatus;
  /** libtest's exec_time (ms); for a test that aborted, the process's time. */
  ms: number;
  /** What the test printed. */
  stdout: string;
  stderr: string;
  /** A failed test's panic message (`assertion `left == right` failed: ...`). */
  message?: string;
  /** Why an ignored test didn't run. */
  ignored?: string;
}

export interface TestRun {
  build: BuildResult;
  ok: boolean;
  tests: TestResult[];
  counts: { passed: number; failed: number; ignored: number; filteredOut: number };
  ms: { build: number; run: number };
}

export interface TestOptions extends BuildOptions {
  /** Only tests whose name contains this (or equals it, with `exact`). */
  filter?: string;
  exact?: boolean;
  /** Run `#[ignore]` tests too. */
  includeIgnored?: boolean;
  /** Per test; default 60 s. */
  timeoutMs?: number;
}

const JSON_ARGS = ['--format', 'json', '-Zunstable-options'];

export async function cargoTest(host: BuildHost, opts: TestOptions): Promise<TestRun> {
  if (!host.runProgram) throw new Error('cargoTest: this build host cannot run programs');
  const run = host.runProgram.bind(host);
  const t0 = performance.now();
  const build = await cargoBuild(host, { ...opts, test: true });
  const t1 = performance.now();
  const tests: TestResult[] = [];
  let filteredOut = 0;
  if (build.ok) {
    for (const exe of build.plan.tests) {
      const u = build.plan.units[exe.unit];
      const program = u.outputs[0];
      const env = [...Object.entries(u.env).map(([k, v]) => `${k}=${v}`), 'RUSTC_BOOTSTRAP=1'];
      const list = await run({ program, args: [program, '--list', ...JSON_ARGS], env, pkgDir: exe.cwd });
      const found = events(list.stdout).filter(e => e.type === 'test' && e.event === 'discovered') as { name: string; ignore: boolean; ignore_message?: string }[];
      if (list.code !== 0 && !found.length) {
        tests.push({ suite: exe.name, package: exe.package, name: '(list)', status: 'failed', ms: list.ms, stdout: list.stdout, stderr: list.stderr, message: panicMessage(list.stderr) ?? list.trap });
        continue;
      }
      const chosen = found.filter(t => !opts.filter || (opts.exact ? t.name === opts.filter : t.name.includes(opts.filter)));
      filteredOut += found.length - chosen.length;
      const results = await pool(chosen, host.workers, async (t): Promise<TestResult> => {
        const base = { suite: exe.name, package: exe.package, name: t.name };
        if (t.ignore && !opts.includeIgnored) {
          return { ...base, status: 'ignored', ms: 0, stdout: '', stderr: '', ignored: t.ignore_message || '#[ignore]' };
        }
        const args = [program, t.name, '--exact', '--nocapture', ...JSON_ARGS, '--report-time', ...(t.ignore ? ['--include-ignored'] : [])];
        const r = await run({ program, args, env, pkgDir: exe.cwd, timeoutMs: opts.timeoutMs ?? 60_000 });
        const ev = events(r.stdout);
        const done = ev.find(e => e.type === 'test' && e.name === t.name && e.event !== 'started') as { event: string; exec_time?: number } | undefined;
        const stdout = r.stdout.split('\n').filter(l => !isEvent(l)).join('\n').replace(/\n+$/, r.stdout.endsWith('\n') ? '\n' : '');
        if (done?.event === 'ok' && r.code === 0) return { ...base, status: 'ok', ms: secs(done.exec_time, r.ms), stdout, stderr: r.stderr };
        if (done?.event === 'ignored') {
          return { ...base, status: 'ignored', ms: 0, stdout, stderr: r.stderr, ignored: 'should_panic tests need unwinding; wasm32-wasip1 aborts on a panic' };
        }
        const message = panicMessage(r.stderr) ?? (r.code === null ? `timed out after ${opts.timeoutMs ?? 60_000} ms` : r.trap ?? `exit ${r.code}`);
        return { ...base, status: 'failed', ms: secs(done?.exec_time, r.ms), stdout, stderr: r.stderr, message };
      });
      tests.push(...results);
    }
  }
  const count = (s: TestStatus) => tests.filter(t => t.status === s).length;
  return {
    build, ok: build.ok && count('failed') === 0, tests,
    counts: { passed: count('ok'), failed: count('failed'), ignored: count('ignored'), filteredOut },
    ms: { build: Math.round(t1 - t0), run: Math.round(performance.now() - t1) },
  };
}

const secs = (s: number | undefined, fallback: number) => (s === undefined ? fallback : Math.round(s * 1e5) / 100);

const isEvent = (l: string) => l.startsWith('{ "type": ') || l.startsWith('{"type":');

function events(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of stdout.split('\n')) {
    if (!isEvent(l)) continue;
    try { out.push(JSON.parse(l)); } catch { /* the test printed something like it */ }
  }
  return out;
}

/** `thread '<name>' panicked at <file>:<line>:<col>:` and the message lines after it. */
function panicMessage(stderr: string): string | undefined {
  const lines = stderr.split('\n');
  const at = lines.findIndex(l => / panicked at /.test(l));
  if (at < 0) return undefined;
  const msg: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l || l.startsWith('note: ') || l.startsWith('stack backtrace')) break;
    msg.push(l);
  }
  return [lines[at].replace(/^thread '[^']*' (\(\d+\) )?/, ''), ...msg].join('\n');
}

/** `f` over `items`, at most `n` at a time, results in order. */
async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await f(items[i]); }
  }));
  return out;
}

// --- clippy

export interface ClippyRun {
  build: BuildResult;
  ok: boolean;
  diagnostics: Diagnostic[];
  /** rustc's rendered text of all of them. */
  rendered: string;
  ms: { build: number; clippy: number };
}

export async function cargoClippy(host: BuildHost, opts: BuildOptions): Promise<ClippyRun> {
  const t0 = performance.now();
  const build = await cargoBuild(host, opts);
  const t1 = performance.now();
  const diagnostics: Diagnostic[] = [];
  let failed = !build.ok;
  if (build.ok) {
    const primary = build.plan.units.filter(u => (u.kind === 'lib' || u.kind === 'bin') && u.env.CARGO_PRIMARY_PACKAGE === '1');
    // One at a time keeps the diagnostics in plan order; there are few primary units.
    for (const u of primary) {
      const f = (opts.resolver as Resolver).finish(u.id, build.scriptOutputs);
      const r = await host.rustc(checkArgs(f.args, `/tmp/clippy/${u.hash}`), f.env, { tool: 'clippy' });
      diagnostics.push(...parseDiagnostics(r.stderr));
      if (r.code !== 0) failed = true;
    }
  }
  return {
    build, ok: !failed, diagnostics, rendered: diagnostics.map(d => d.rendered).join(''),
    ms: { build: Math.round(t1 - t0), clippy: Math.round(performance.now() - t1) },
  };
}

/** A unit's compile as `cargo check` would run it: metadata only, into `outDir`, no incremental dir. */
function checkArgs(args: string[], outDir: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--emit=')) out.push('--emit=metadata');
    else if (a === '--out-dir') { out.push(a, outDir); i++; }
    else if (a === '-C' && args[i + 1]?.startsWith('incremental=')) i++;
    else out.push(a);
  }
  return out;
}
