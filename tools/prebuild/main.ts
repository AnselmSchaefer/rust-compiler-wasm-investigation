// tools/prebuild (WP-18): fill the L2 build cache natively. It runs the browser's `cargo build`
// (web/build/cargo.ts: same resolver, planner, cache keys and bundles) with a host that runs the
// release's own rustc.wasm and wasm-ld.wasm under wasmtime, and build scripts under wasmtime too.
// The guest sees a directory on disk as `/`, laid out like the browser's VFS (/sysroot, /deps,
// /target, the project at /<name>), so outputs are bit-identical to a browser build.
//
//   node build/prebuild/prebuild.mjs [--release DIR] [--out DIR] [--report FILE] [--jobs N] [--rebuild] CASE_DIR...
//
// CASE_DIR holds Cargo.toml and src/. --out is the L2 directory (default build/l2/<RUSTC_ID>/):
// every built unit's bundle lands there, and units already there are hits. --rebuild builds
// everything again (and overwrites). The report (JSON) lists every unit's key and output hashes,
// which scripts/verify/wp-18.sh compares with a browser build's. Built by scripts/build-prebuild.mjs.

import { spawn } from 'node:child_process';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type BuildFs, type BuildHost, cargoBuild, type BuildResult } from '../../web/build/cargo';
import { bundlePath, decodeBundle, UnitCache } from '../../web/build/cache';
import type { ByteStore } from '../../web/deps/cache';
import { Resolver } from '../../web/deps/resolver';
import { readTar } from '../../web/orchestrator/tar';
import type { Manifest } from '../../web/orchestrator/toolchain';
import { linkerSpawnError, outputDestination, parseLinkCommand, rewriteOutputs, wasmLdArgs } from '../../web/link/link-args';
import { Kind } from '../../web/vfs/vfs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WASMTIME_THREADS = process.env.WASMTIME_THREADS ?? 'wasmtime-threads';
const WASMTIME = process.env.WASMTIME ?? 'wasmtime';

// --- arguments
const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bool = (name: string) => { const i = argv.indexOf(name); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const releaseDir = resolve(flag('--release') ?? newestRelease());
const jobs = Number(flag('--jobs') ?? 4);
const rebuild = bool('--rebuild');
const manifest: Manifest = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'));
const RUSTC_ID = manifest.RUSTC_ID;
const outDir = resolve(flag('--out') ?? join(REPO, 'build/l2', RUSTC_ID));
const reportFile = flag('--report');
const work = resolve(flag('--work') ?? join(REPO, 'build/prebuild/work'));
const cases = argv.map(c => resolve(c));
if (!RUSTC_ID || !cases.length) { console.error('usage: prebuild [--release DIR] [--out DIR] [--report FILE] [--jobs N] [--rebuild] CASE_DIR...'); process.exit(2); }

function newestRelease() {
  const base = join(REPO, 'build/release');
  return join(base, readdirSync(base).filter(d => statSync(join(base, d)).isDirectory()).sort((a, b) => statSync(join(base, b)).mtimeMs - statSync(join(base, a)).mtimeMs)[0]);
}

// --- the guest's root directory, laid out like the orchestrator's VFS
const root = join(work, 'root');
const tools = join(work, 'tools', RUSTC_ID);

/** A release file, checked against the manifest and decompressed (cached under `tools`). */
function releaseFile(entry: { file: string; sha256: string }): string {
  const name = entry.file.replace(/\.br$/, '');
  const dst = join(tools, name);
  if (existsSync(dst)) return dst;
  const raw = brotliDecompressSync(readFileSync(join(releaseDir, `${name}.br`)));
  const got = createHash('sha256').update(raw).digest('hex');
  if (got !== entry.sha256) throw new Error(`${name}: sha256 ${got}, manifest says ${entry.sha256}`);
  mkdirSync(tools, { recursive: true });
  writeFileSync(`${dst}.tmp`, raw);
  renameSync(`${dst}.tmp`, dst);
  return dst;
}

function setupRoot() {
  const stamp = join(root, '.sysroot-' + RUSTC_ID);
  if (!existsSync(stamp)) {
    rmSync(join(root, 'sysroot'), { recursive: true, force: true });
    for (const group of ['meta', 'link'] as const) {
      const tar = readFileSync(releaseFile(manifest.sysroot[group]));
      for (const e of readTar(tar)) {
        const p = join(root, 'sysroot', e.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, e.data);
      }
    }
    // As in Orchestrator.create: rustc trusts argv[0] for its sysroot only if it's a symlink, then
    // checks lib/rustlib relative to the working directory (/). Relative links: wasmtime refuses
    // absolute ones.
    mkdirSync(join(root, 'sysroot/bin'), { recursive: true });
    symlinkSync('../lib/rustc-is-a-wasm-module', join(root, 'sysroot/bin/rustc'));
    mkdirSync(join(root, 'lib'), { recursive: true });
    rmSync(join(root, 'lib/rustlib'), { force: true });
    symlinkSync('../sysroot/lib/rustlib', join(root, 'lib/rustlib'));
    writeFileSync(stamp, '');
  }
  for (const d of ['tmp', 'proc']) mkdirSync(join(root, d), { recursive: true });
}

// --- the host
class DiskFs implements BuildFs {
  constructor(private readonly root: string) {}
  private p(path: string) { return join(this.root, path); }
  exists(path: string) { return existsSync(this.p(path)); }
  readFile(path: string) { return new Uint8Array(readFileSync(this.p(path))); }
  readText(path: string) { return readFileSync(this.p(path), 'utf8'); }
  writeFile(path: string, data: Uint8Array | string) { mkdirSync(dirname(this.p(path)), { recursive: true }); writeFileSync(this.p(path), data); }
  mkdirAll(path: string) { mkdirSync(this.p(path), { recursive: true }); }
  readdir(path: string) {
    return readdirSync(this.p(path), { withFileTypes: true }).map(e => ({ name: e.name, ino: 0, kind: e.isDirectory() ? Kind.Dir : e.isSymbolicLink() ? Kind.Symlink : Kind.File }));
  }
}

class DiskStore implements ByteStore {
  constructor(private readonly dir: string, private readonly writeOnly = false) {}
  async read(path: string) { return this.writeOnly || !existsSync(join(this.dir, path)) ? null : new Uint8Array(readFileSync(join(this.dir, path))); }
  async write(path: string, data: Uint8Array) {
    const p = join(this.dir, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp`, data);
    renameSync(`${p}.tmp`, p);
  }
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((ok, fail) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    c.stdout.on('data', d => out.push(d));
    c.stderr.on('data', d => err.push(d));
    c.on('error', fail);
    c.on('close', code => ok({ code: code ?? 1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
}

// wasmtime 46 warns about -Sthreads on every run; rustc.wasm is panic=abort, so a fatal error ends
// in a trap whose backtrace says nothing (as in toolchain/rustc-wasm.ts).
const quiet = (s: string) => s.split('\n').filter(l => !l.startsWith('WARNING: the `-Sthreads`') && !/^ +$/.test(l)).join('\n')
  .replace(/^Error: (?:failed to run main module|error while executing at wasm backtrace)[\s\S]*?wasm trap: wasm `unreachable` instruction executed\n?/m,
    t => (/^\s+0: [^\n]*!abort$/m.test(t) ? '' : t));
const threaded = (argv0: string, module: string, env: Record<string, string>, args: string[]) =>
  run(WASMTIME_THREADS, ['run', '-W', 'threads=y,shared-memory=y,exceptions=y', '-S', 'threads=y', '--dir', `${root}::/`,
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--argv0', argv0, module, ...args]);

let jobCount = 0;
let free = jobs;
const waiting: (() => void)[] = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (free > 0) free--; else await new Promise<void>(r => waiting.push(r));
  try { return await f(); } finally { const w = waiting.shift(); if (w) w(); else free++; }
}

function diskHost(): BuildHost {
  const fs = new DiskFs(root);
  const rustcWasm = releaseFile(manifest.rustc);
  const lldWasm = releaseFile(manifest.lld);
  return {
    vfs: fs, rustcId: RUSTC_ID, workers: jobs,
    // Orchestrator.run, on disk: outputs go to a scratch dir, rustc stops at the link step, wasm-ld
    // links, the results move into place.
    rustc: (user, env) => slot(async () => {
      const t0 = performance.now();
      const scratch = `/tmp/job-${++jobCount}`, linkFile = `${scratch}/link-args`;
      fs.mkdirAll(scratch);
      try {
        const plan = rewriteOutputs(user, scratch, linkFile);
        const r = await threaded('/sysroot/bin/rustc', rustcWasm, { RUST_MIN_STACK: '16777216', ...env }, plan.args);
        const ms = Math.round(performance.now() - t0);
        let code = r.code, stderr = quiet(r.stderr);
        if (code !== 0 && fs.exists(linkFile)) {
          const at = linkerSpawnError(stderr);
          if (at >= 0) {
            stderr = stderr.slice(0, at);
            const ld = await threaded('wasm-ld', lldWasm, {}, wasmLdArgs(parseLinkCommand(fs.readText(linkFile))));
            code = ld.code;
            stderr += quiet(ld.stderr);
          }
        }
        if (code === 0) {
          for (const e of fs.readdir(scratch)) {
            const dst = outputDestination(plan, e.name);
            if (!dst || e.kind !== Kind.File || e.name === 'link-args') continue;
            const to = dst.startsWith('./') ? dst.slice(1) : dst.startsWith('/') ? dst : `/${dst}`;
            fs.mkdirAll(dirname(to));
            renameSync(join(root, scratch, e.name), join(root, to));
          }
        }
        return { code, stderr, ms: { rustc: ms } };
      } finally {
        rmSync(join(root, scratch), { recursive: true, force: true });
      }
    }),
    // The sandbox, on disk: the package dir and an empty OUT_DIR, nothing else.
    runScript: o => slot(async () => {
      rmSync(join(root, o.outDir), { recursive: true, force: true });
      fs.mkdirAll(o.outDir);
      const r = await run(WASMTIME, ['run', '--dir', `${join(root, o.pkgDir)}::${o.pkgDir}`, '--dir', `${join(root, o.outDir)}::${o.outDir}`,
        ...o.env.flatMap(e => ['--env', e]), '--argv0', o.args[0], join(root, o.program), ...o.args.slice(1)]);
      const files: Record<string, Uint8Array> = {};
      const walk = (d: string) => { for (const e of fs.readdir(d)) { const p = `${d}/${e.name}`; if (e.kind === Kind.Dir) walk(p); else if (e.kind === Kind.File) files[p] = fs.readFile(p); } };
      walk(o.outDir);
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, files };
    }),
  };
}

// --- index and downloads: the WP-15 snapshot from disk, crates from static.crates.io
const INDEX = join(REPO, 'build/wp-15/index');
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('file:')) {
    try { return new Response(readFileSync(fileURLToPath(url))); } catch { return new Response(null, { status: 404 }); }
  }
  // crates.io's crawler policy asks for a User-Agent that says who we are.
  return realFetch(input, { ...init, headers: { 'User-Agent': 'browser-rust-ide-prebuild/0.1 (WP-18 dev tool)', ...init?.headers } });
}) as typeof fetch;

// --- main
setupRoot();
const host = diskHost();
const resolverModule = await WebAssembly.compile(readFileSync(join(REPO, 'build/www/resolver/resolver.wasm')));
const depsCache = new DiskStore(join(work, 'deps-cache'));
const report: { rustcId: string; jobs: number; cases: Record<string, unknown> } = { rustcId: RUSTC_ID, jobs, cases: {} };
for (const c of cases) {
  const name = c.split('/').pop()!;
  const project = `/${name}`;
  rmSync(join(root, name), { recursive: true, force: true });
  mkdirSync(join(root, name), { recursive: true });
  cpSync(join(c, 'Cargo.toml'), join(root, name, 'Cargo.toml'));
  cpSync(join(c, 'src'), join(root, name, 'src'), { recursive: true });
  const store = new DiskStore(outDir, rebuild);
  const t0 = performance.now();
  const r: BuildResult = await cargoBuild(host, {
    project, resolver: await Resolver.instantiate(resolverModule), index: pathToFileURL(INDEX).href + '/', cache: depsCache, units: new UnitCache(store),
  });
  if (!r.ok) { console.error(`[${name}] build failed:\n${r.errors}`); process.exit(1); }
  const bin = Object.values(r.bins)[0];
  const ran = bin ? await run(WASMTIME, ['run', join(root, bin)]) : null;
  const counts = r.units.reduce((a: Record<string, number>, u) => { const k = u.cached ?? 'built'; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  console.log(`[${name}] ${r.packages} packages, ${r.units.length} units (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}) in ${Math.round(performance.now() - t0)} ms; run: exit ${ran?.code}`);
  report.cases[name] = { ok: r.ok, ms: r.ms, run: ran, units: r.units.map(u => ({ name: u.name, version: u.version, kind: u.kind, key: u.key, cached: u.cached, files: u.files })) };
}
// Every stored bundle must still decode (a cheap check that writes completed).
for (const c of Object.values(report.cases) as { units: { key: string }[] }[])
  for (const u of c.units) decodeBundle(new Uint8Array(readFileSync(join(outDir, bundlePath(u.key)))));
if (reportFile) { mkdirSync(dirname(resolve(reportFile)), { recursive: true }); writeFileSync(reportFile, JSON.stringify(report, null, 2)); }
console.log(`L2: ${outDir}`);
process.exit(0);
