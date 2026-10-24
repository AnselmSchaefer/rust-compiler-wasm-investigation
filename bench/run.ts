// Benchmark harness (WP-02). `pnpm bench [--iters N] [--firefox] [--no-native] [--rustc rustc_opt.wasm]`
// Measures the same rustc invocations in Chromium (required), Firefox (optional), wasmtime-threads and native rustc,
// and writes bench/results/<date>-<commit>.json. Compare two runs with `node bench/compare.ts a.json b.json`.
import { chromium, firefox, type Browser, type BrowserType } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { cpus, totalmem, release } from 'node:os';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string, def: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const ITERS = Number(opt('--iters', '5'));
const RUSTC = opt('--rustc', 'rustc_opt.wasm');
const NATIVE_TOOLCHAIN = '1.83.0'; // same version as the oligamiq build (1.83.0-dev)
const PORT = 8788;
const VENDOR = 'build/vendor/rust_wasm-v3';

const programs = {
  hello: readFileSync('bench/programs/hello.rs', 'utf8'),
  medium: readFileSync('bench/programs/medium.rs', 'utf8'),
};

// Paths are absolute in the guest (work dir mounted at /); native runs rewrite them.
const common = ['--sysroot', '/sysroot', '--target', 'wasm32-wasip1', '--edition', '2021'];
const steps: Record<string, string[]> = {
  'version': ['-V'],
  'check-hello': ['/hello.rs', ...common, '--emit=metadata', '-o', '/hello.rmeta'],
  'build-hello': ['/hello.rs', ...common, '-o', '/hello.wasm'],
  'check-medium': ['/medium.rs', ...common, '--emit=metadata', '-o', '/medium.rmeta'],
  'build-medium': ['/medium.rs', ...common, '-o', '/medium.wasm'],
  'build-medium-O': ['/medium.rs', ...common, '-O', '-o', '/medium-opt.wasm'],
};
const runs = { 'run-hello': ['/hello.wasm', 'Hello'], 'run-medium': ['/medium.wasm', 'medium ok'] } as const;

type Stat = { runs: number[]; first: number; median: number; min: number; [k: string]: unknown };
const stat = (xs: number[], extra: Record<string, unknown> = {}): Stat => {
  const s = [...xs].sort((a, b) => a - b);
  return { runs: xs, first: xs[0], median: s[Math.floor(s.length / 2)], min: s[0], ...extra };
};
const log = (...a: unknown[]) => console.error(...a);

// ---------- memory sampling ----------

// Peak RSS of every process below this one (the browser and its renderers, GPU and utility processes).
// Sampled from /proc every 50 ms while a step runs; the dev server is excluded.
const PAGE = 4096;
function treeRss(exclude: number): number {
  const parent = new Map<number, number>(), rss = new Map<number, number>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      parent.set(Number(d), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
      rss.set(Number(d), Number(readFileSync(`/proc/${d}/statm`, 'utf8').split(' ')[1]) * PAGE);
    } catch { /* process exited */ }
  }
  let total = 0;
  for (const [pid, bytes] of rss) {
    if (pid === exclude) continue;
    for (let p = parent.get(pid); p; p = parent.get(p)) {
      if (p === exclude) break;
      if (p === process.pid) { total += bytes; break; }
    }
  }
  return total;
}
async function peakRss<T>(exclude: number, f: () => Promise<T>): Promise<[T, number]> {
  let peak = treeRss(exclude);
  const timer = setInterval(() => { peak = Math.max(peak, treeRss(exclude)); }, 50);
  try { return [await f(), peak]; } finally { clearInterval(timer); }
}

// ---------- browsers ----------

async function benchBrowser(type: BrowserType, args: string[] = []) {
  const browser: Browser = await type.launch({ args });
  const result: Record<string, unknown> = { version: browser.version() };
  try {
    // Cold load: fresh context each time (no HTTP cache; server also sends no-store).
    const loads: Record<string, number>[] = [];
    for (let i = 0; i < Math.min(ITERS, 3); i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/www/baseline/index.html`);
      await page.waitForFunction(() => (window as any).harnessReady);
      loads.push(await page.evaluate(r => (window as any).harness.load(r), RUSTC));
      await ctx.close();
    }
    const last = loads.at(-1)!;
    result.load = {
      totalMs: stat(loads.map(l => l.totalMs)),
      fetchMs: stat(loads.map(l => Math.max(l.fetchSysrootMs, l.fetchRustcMs))),
      compileRustcMs: stat(loads.map(l => l.compileRustcMs)),
      transferBytes: last.transferBytes,
      rustcBytes: last.rustcBytes,
      // Download time alone at 100 Mbit/s, for the WP-28 first-visit target.
      est100MbitDownloadMs: Math.round((last.transferBytes * 8) / 100e6 * 1000),
    };

    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', e => log('[pageerror]', e.message));
    await page.goto(`http://localhost:${PORT}/www/baseline/index.html`);
    await page.waitForFunction(() => (window as any).harnessReady);
    await page.evaluate(([r, p]) => {
      const h = (window as any).harness;
      return h.load(r).then(() => { for (const [k, v] of Object.entries(p)) h.writeFile(`/${k}.rs`, v); });
    }, [RUSTC, programs] as const);

    const stepResults: Record<string, Stat> = {};
    for (const [name, a] of Object.entries(steps)) {
      const ms: number[] = [], mem: number[] = [], rss: number[] = [];
      for (let i = 0; i < ITERS; i++) {
        const [r, peak] = await peakRss(server.pid!, () => page.evaluate(a => (window as any).harness.rustc(a), a));
        if (r.code !== 0) throw new Error(`${name}: rustc exit ${r.code} ${r.error ?? ''}\n${r.stderr}`);
        ms.push(r.ms); mem.push(r.memBytes); rss.push(peak);
      }
      stepResults[name] = stat(ms, { wasmMemoryBytes: Math.max(...mem), browserPeakRssBytes: Math.max(...rss) });
      log(`  ${type.name()} ${name}: median ${stepResults[name].median} ms, first ${ms[0]} ms, ` +
        `wasm mem ${(Math.max(...mem) / 2 ** 20).toFixed(0)} MiB, browser RSS ${(Math.max(...rss) / 2 ** 20).toFixed(0)} MiB`);
    }
    for (const [name, [path, expect]] of Object.entries(runs)) {
      const ms: number[] = [];
      for (let i = 0; i < ITERS; i++) {
        const r = await page.evaluate(p => (window as any).harness.run(p), path);
        if (!r.stdout.includes(expect)) throw new Error(`${name}: unexpected output ${r.stdout}`);
        ms.push(r.ms);
      }
      stepResults[name] = stat(ms);
    }
    result.steps = stepResults;
    // Not exposed in Playwright's headless Chromium; recorded when available.
    result.measureMemoryBytes = await page.evaluate(() => (window as any).harness.measureMemory()).catch(() => undefined);
  } finally {
    await browser.close();
  }
  return result;
}

// ---------- wasmtime and native ----------

function measure(cwd: string, cmd: string[]) {
  return JSON.parse(execFileSync('python3', ['bench/measure.py', cwd, ...cmd], { maxBuffer: 1 << 24 }).toString());
}

function benchCli(kind: 'wasmtime' | 'native') {
  const work = resolve(`build/bench/${kind}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const k of Object.keys(programs)) copyFileSync(`bench/programs/${k}.rs`, `${work}/${k}.rs`);
  const sysroot = resolve(`${VENDOR}/sysroot`);

  const cmdFor = (a: string[]): string[] => kind === 'wasmtime'
    // rustc puts its temp dir at /rustcXXXX, so the work dir is mounted at /.
    ? ['wasmtime-threads', 'run', '-W', 'threads=y,shared-memory=y', '-S', 'threads=y',
       '--dir', `${work}::/`, '--dir', `${sysroot}::/sysroot`, resolve(`${VENDOR}/${RUSTC}`), ...a]
    : ['rustup', 'run', NATIVE_TOOLCHAIN, 'rustc',
       ...a.filter((x, i) => x !== '--sysroot' && a[i - 1] !== '--sysroot').map(x => x.startsWith('/') ? work + x : x)];

  const result: Record<string, unknown> = {};
  if (kind === 'native') result.version = execFileSync('rustup', ['run', NATIVE_TOOLCHAIN, 'rustc', '-V']).toString().trim();
  else result.version = execFileSync('wasmtime-threads', ['--version']).toString().trim();
  const stepResults: Record<string, Stat> = {};
  for (const [name, a] of Object.entries(steps)) {
    const ms: number[] = [], rss: number[] = [];
    for (let i = 0; i < ITERS; i++) {
      const r = measure(work, cmdFor(a));
      if (r.code !== 0) throw new Error(`${kind} ${name}: exit ${r.code}\n${r.stderr}`);
      ms.push(r.ms); rss.push(r.maxRssKB);
    }
    stepResults[name] = stat(ms, { maxRssBytes: Math.max(...rss) * 1024 });
    log(`  ${kind} ${name}: median ${stepResults[name].median} ms, first ${ms[0]} ms`);
  }
  for (const [name, [path, expect]] of Object.entries(runs)) {
    const ms: number[] = [];
    for (let i = 0; i < ITERS; i++) {
      const r = measure(work, ['wasmtime', 'run', `${work}${path}`]);
      if (!r.stdout.includes(expect)) throw new Error(`${kind} ${name}: unexpected output ${r.stdout}`);
      ms.push(r.ms);
    }
    stepResults[name] = stat(ms);
  }
  result.steps = stepResults;
  return result;
}

// ---------- main ----------

execFileSync('bash', ['scripts/fetch-baseline.sh'], { stdio: ['ignore', 'ignore', 'inherit'] });
execFileSync('node', ['scripts/build-baseline.mjs'], { stdio: ['ignore', 'ignore', 'inherit'] });
const server = spawn('node', ['scripts/serve.mjs', 'tests/e2e/fixtures', '/www=build/www', '/vendor=build/vendor'],
  { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 500));

const git = (...a: string[]) => execFileSync('git', a).toString().trim();
const commit = git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain') ? '-dirty' : '');
const out: Record<string, unknown> = {
  date: new Date().toISOString(),
  commit,
  toolchain: `oligamiq rust_wasm v3.0.0 ${RUSTC}`,
  iters: ITERS,
  machine: { cpu: cpus()[0].model, cores: cpus().length, memBytes: totalmem(), kernel: release(), node: process.version },
  browsers: {} as Record<string, unknown>,
};
try {
  log('chromium');
  (out.browsers as any).chromium = await benchBrowser(chromium, ['--enable-blink-features=ForceEagerMeasureMemory']);
  if (flag('--firefox')) {
    log('firefox (best-effort)');
    try { (out.browsers as any).firefox = await benchBrowser(firefox); }
    catch (e) { log('firefox failed (not required):', e); }
  }
  if (!flag('--no-native')) {
    log('wasmtime');
    out.wasmtime = benchCli('wasmtime');
    log('native');
    out.native = benchCli('native');
  }
} finally {
  server.kill();
}

mkdirSync('bench/results', { recursive: true });
const file = `bench/results/${out.date!.toString().slice(0, 10)}-${commit}.json`;
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(file);
