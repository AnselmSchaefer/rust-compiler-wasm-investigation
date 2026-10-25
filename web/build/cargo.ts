// `cargo build` in the browser (WP-17): resolve and fetch the dependencies (web/deps), plan the
// units (the planner in crates/resolver), then run them on the orchestrator: each unit as soon as
// its dependencies are done, compiles on up to `workers` compile servers at once. Build scripts
// are wasm32-wasip1 programs; each runs in the run sandbox with a copy of its package's files,
// cargo's environment and an empty OUT_DIR, which is copied back. Their `cargo:` output goes
// into the package's rustc invocation (`Resolver.finish`).
//
// WP-18: every unit has a cache key (cache.ts). Outputs already in the VFS from an earlier build
// here, or in the build cache (L1/L2), are used as they are; a hit needs none of its
// dependencies, and a miss first puts its whole dependency closure in place. Built units go
// into L1. The host is the browser (browser-host.ts) or wasmtime (tools/prebuild), so both build
// the same plan with the same keys.
//
// WP-21: host-side units (build scripts and what they use, proc macros) are compiled against the
// build-script std (bs-std/lib.rs; a cached unit of its own, built first), whose `Command` sends
// `rustc` runs back here (spawn.ts). Scripts run in their package dir. A package on the override
// list (overrides.ts) doesn't run its script: the listed output stands in for it.
//
// Paths: the project at `project` (a package or a workspace, WP-25), crates under
// /deps/<name>-<version>/, outputs under /target/ (shared by all projects) in cargo's layout.

import { fetchDependencies, type DepsOptions, type DepsResult } from '../deps/deps';
import type { Plan, PlanInput, PlanUnit, Resolver } from '../deps/resolver';
import { Kind, type Vfs } from '../vfs/vfs';
import { type Bundle, type CacheLevel, makeBundle, sha256, sourceId, type UnitCache, unitKey } from './cache';
import BS_STD from './bs-std/lib.rs';
import { findOverride, type Override } from './overrides';
import { decodeSpawn, encodeSpawnResult, runSpawn } from './spawn';
import { type Diagnostic, parseDiagnostics } from './diagnostics';

/** The files a build touches: the orchestrator's VFS, or a directory on disk (tools/prebuild). */
export type BuildFs = Pick<Vfs, 'exists' | 'readFile' | 'readText' | 'writeFile' | 'readdir' | 'mkdirAll' | 'removeAll'>;

/** Where units run: the browser (browser-host.ts) or wasmtime (tools/prebuild). */
export interface BuildHost {
  vfs: BuildFs;
  rustcId: string;
  workers: number;
  /**
   * rustc with these args and env, linking if needed; outputs land where the args say. `io`: a
   * build script's probe, with its working directory and stdin (an input of `-`).
   */
  rustc(args: string[], env: Record<string, string>, io?: { cwd?: string; stdin?: string; tool?: 'clippy' }):
    Promise<{ code: number; stderr: string; stdout?: string; ms: { rustc: number } }>;
  /**
   * A build script (wasm32-wasip1) with its package dir readable and an empty `outDir`; returns
   * OUT_DIR's files. `call` answers its host calls (a request in spawn.ts's format → the answer);
   * the host makes sure rustc sees the script's OUT_DIR as it is at that moment, and the script
   * sees what rustc wrote there.
   */
  runScript(o: { program: string; args: string[]; env: string[]; pkgDir: string; outDir: string; call: (req: Uint8Array) => Promise<Uint8Array> }):
    Promise<{ code: number | null; trap?: string; stdout: string; stderr: string; files: Record<string, Uint8Array> }>;
  /** A program (a test harness, WP-26) with the files below `pkgDir` readable; no host calls. */
  runProgram?(o: { program: string; args: string[]; env: string[]; pkgDir: string; timeoutMs?: number }):
    Promise<{ code: number | null; trap?: string; stdout: string; stderr: string; ms: number }>;
}

export interface BuildOptions {
  /** Directory with Cargo.toml and src/. */
  project: string;
  resolver: Resolver;
  /** Sparse-index base URL (ending in '/') and crate download base. */
  index: string;
  dl?: string;
  /** The dependency cache (index files, .crate files). */
  cache?: DepsOptions['cache'];
  /** The build cache (WP-18); without it every unit runs. */
  units?: UnitCache;
  /** Default /target, shared by all projects, so registry crates' outputs don't depend on the project. */
  targetDir?: string;
  features?: string[];
  /** `cargo test`'s units (WP-26): dev-dependencies, examples, test harnesses. */
  test?: boolean;
  /** `cargo check` (WP-27): target-side units only emit metadata; no executables. */
  check?: boolean;
  defaultFeatures?: boolean;
  /** Overrides of cargo's dev profile. Default: no incremental, debuginfo 0 (WP-27). */
  profile?: PlanInput['profile'];
  /** Build scripts that don't run (overrides.ts); default: the built-in list. */
  overrides?: Override[];
  onUnit?: (u: UnitReport) => void;
}

export interface UnitReport {
  id: number; name: string; version: string; kind: PlanUnit['kind'];
  /** The cache key, and where the outputs came from: a cache level, the VFS (unchanged since an earlier build here), or built. */
  key: string; cached?: CacheLevel | 'fresh';
  /** ms since the build started. */
  start: number; end: number;
  /** rustc's ms (compile units that ran). */
  rustcMs?: number;
  /** Output path → sha256. */
  files: Record<string, string>;
  /** Build-script runs: what the script printed (its `cargo:` lines). */
  stdout?: string;
  /** rustc's diagnostics of the unit's compile (WP-38), replayed from the cache on a hit. */
  diagnostics?: Diagnostic[];
  warnings: string[];
}

export interface BuildResult {
  ok: boolean;
  /** bin name → executable in the VFS. */
  bins: Record<string, string>;
  /** Diagnostics of the failed unit(s). */
  errors: string;
  /** rustc's diagnostics as data (WP-38): the path packages' units that ran, and failed units. */
  diagnostics: Diagnostic[];
  units: UnitReport[];
  /** Planned units that weren't needed: everything that depends on them was a cache hit. */
  skipped: number;
  packages: number;
  workers: number;
  cache: UnitCache['stats'] | null;
  ms: { deps: number; plan: number; build: number; store: number; total: number };
  /** The plan, and what each build script printed (run unit id → stdout): for test.ts. */
  plan: Plan;
  scriptOutputs: Record<number, string>;
}

const TARGET = 'wasm32-wasip1';

class UnitError extends Error {
  constructor(message: string, readonly diagnostics: Diagnostic[] = []) { super(message); }
}

/** Per VFS: unit key → its outputs, already in place from an earlier build in this session. */
const inPlace = new WeakMap<object, Map<string, { files: Record<string, string>; stdout?: string; diagnostics?: Diagnostic[] }>>();

export async function cargoBuild(host: BuildHost, opts: BuildOptions): Promise<BuildResult> {
  const t0 = performance.now();
  const vfs = host.vfs;
  // The whole project goes to the resolver, which finds the workspace's members (WP-25).
  const project = { root: opts.project, manifests: projectManifests(vfs, opts.project) };
  const deps = await fetchDependencies(project, vfs, { resolver: opts.resolver, index: opts.index, dl: opts.dl, cache: opts.cache, dir: '/deps' });
  // Like cargo, keep the project's Cargo.lock current (before the planner lists the files).
  const lockPath = `${opts.project}/Cargo.lock`;
  if (!vfs.exists(lockPath) || vfs.readText(lockPath) !== deps.lock) vfs.writeFile(lockPath, deps.lock);
  const t1 = performance.now();
  const std = await hostStd(host, opts);
  const input = planInput(vfs, opts, deps, host, std.path);
  const plan = opts.resolver.plan(input);
  const t2 = performance.now();

  let fresh = inPlace.get(vfs);
  if (!fresh) inPlace.set(vfs, fresh = new Map());
  const sources = new Map<number, Promise<string>>();
  const source = (pkg: number) => {
    let s = sources.get(pkg);
    if (!s) {
      const p = input.packages[pkg];
      sources.set(pkg, s = sourceId(deps.packages[pkg], p.source === 'path' ? p.files.map(f => [f, vfs.readFile(`${p.dir}/${f}`)]) : undefined));
    }
    return s;
  };
  const keys = new Map<number, Promise<string>>();
  const keyOf = (u: PlanUnit): Promise<string> => {
    let k = keys.get(u.id);
    if (!k) {
      keys.set(u.id, k = Promise.all([source(u.pkg), Promise.all(u.deps.map(d => keyOf(plan.units[d])))])
        .then(([src, dk]) => unitKey({ rustcId: host.rustcId, kind: u.kind, args: overridden(u) ? ['override', JSON.stringify(overridden(u))] : u.args, env: u.env, source: src, deps: dk })));
    }
    return k;
  };

  const overridden = (u: PlanUnit) => (u.kind === 'run-custom-build' ? findOverride(opts.overrides, u.name, u.version) : undefined);
  const closure = (u: PlanUnit, seen = new Set<number>()): Set<number> => {
    for (const d of u.deps) if (!seen.has(d)) { seen.add(d); closure(plan.units[d], seen); }
    return seen;
  };

  const units: UnitReport[] = [];
  const outputs: Record<number, string> = {};
  const errors: string[] = [];
  const failedDiagnostics: Diagnostic[] = [];
  const stores: Promise<void>[] = [];
  const done = new Map<number, Promise<void>>();
  const unit = (u: PlanUnit): Promise<void> => {
    let p = done.get(u.id);
    if (!p) {
      p = (async () => {
        const key = await keyOf(u);
        let start = performance.now() - t0;
        const report = (r: { cached?: UnitReport['cached']; rustcMs?: number; files: Record<string, string>; stdout?: string; warnings: string[]; diagnostics?: Diagnostic[] }) => {
          const rep = { id: u.id, name: u.name, version: u.version, kind: u.kind, key, start: Math.round(start), end: Math.round(performance.now() - t0), ...r };
          units.push(rep);
          opts.onUnit?.(rep);
        };
        const here = fresh.get(key);
        if (here && Object.keys(here.files).every(f => vfs.exists(f))) {
          if (here.stdout !== undefined) outputs[u.id] = here.stdout;
          return report({ cached: 'fresh', files: here.files, stdout: here.stdout, warnings: [], diagnostics: here.diagnostics });
        }
        const hit = await opts.units?.get(key);
        if (hit) {
          restore(vfs, u, hit.bundle, outputs);
          const files = hashes(hit.bundle);
          const diagnostics = hit.bundle.diagnostics as Diagnostic[] | undefined;
          fresh.set(key, { files, stdout: hit.bundle.stdout, diagnostics });
          return report({ cached: hit.from, files, stdout: hit.bundle.stdout, warnings: [], diagnostics });
        }
        // rustc reads the dependencies' dependencies too (-L dependency=), so a miss needs the
        // whole closure in place; a hit above didn't put its own dependencies there.
        await Promise.all([...closure(u)].map(d => unit(plan.units[d])));
        start = performance.now() - t0;
        if (plan.units.some(x => x.host && x.kind !== 'run-custom-build')) await std.ready();
        const o = overridden(u);
        const r = o ? await overrideBuildScript(host, u, o, outputs)
          : u.kind === 'run-custom-build' ? await runBuildScript(host, opts.resolver, u, outputs) : await compile(host, opts.resolver, u, outputs);
        const files = hashes(r.bundle);
        fresh.set(key, { files, stdout: r.bundle.stdout, diagnostics: r.diagnostics });
        if (opts.units) stores.push(opts.units.put(key, r.bundle));
        report({ rustcMs: r.rustcMs, files, stdout: r.bundle.stdout, warnings: r.warnings, diagnostics: r.diagnostics });
      })().catch(e => {
        if (e instanceof UnitError) { errors.push(e.message); failedDiagnostics.push(...e.diagnostics); }
        throw e;
      });
      done.set(u.id, p);
    }
    return p;
  };
  // A test plan's roots are its harnesses, examples and bins: everything.
  const roots = opts.test ? [] : plan.bins.map(([, id]) => plan.units[id]);
  const results = await Promise.allSettled((roots.length ? roots : plan.units).map(unit));
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed && !(failed.reason instanceof UnitError)) throw failed.reason;

  const bins: Record<string, string> = {};
  if (!failed && !opts.check) {
    // cargo "uplifts" executables out of deps/ to target/<triple>/<profile>/<name>.wasm.
    for (const [name, id] of plan.bins) {
      const from = plan.units[id].outputs[0];
      const to = `${from.slice(0, from.lastIndexOf('/deps/'))}/${name}.wasm`;
      vfs.writeFile(to, vfs.readFile(from));
      bins[name] = to;
    }
  }
  const t3 = performance.now();
  await Promise.all(stores);
  const t4 = performance.now();
  return {
    ok: !failed, bins, errors: [...new Set(errors)].join('\n'),
    diagnostics: [...units.flatMap(u => u.diagnostics ?? []), ...failedDiagnostics], units: units.sort((a, b) => a.start - b.start), skipped: plan.units.length - units.length,
    packages: deps.packages.length, workers: host.workers, cache: opts.units?.stats ?? null,
    ms: { deps: Math.round(t1 - t0), plan: Math.round(t2 - t1), build: Math.round(t3 - t2), store: Math.round(t4 - t3), total: Math.round(t4 - t0) },
    plan, scriptOutputs: outputs,
  };
}

const hashes = (b: Bundle) => Object.fromEntries(b.files.map(f => [f.path, f.sha256]));

/** A cache hit's files into the VFS; a build-script run also gets its stdout back, as when it ran. */
function restore(vfs: BuildFs, u: PlanUnit, b: Bundle, outputs: Record<number, string>) {
  if (u.out_dir) vfs.mkdirAll(u.out_dir);
  for (const f of b.files) vfs.writeFile(f.path, f.data);
  if (u.kind === 'run-custom-build') {
    outputs[u.id] = b.stdout ?? '';
    vfs.writeFile(`${u.out_dir!.slice(0, u.out_dir!.lastIndexOf('/'))}/output`, b.stdout ?? '');
  }
}

function planInput(vfs: BuildFs, opts: BuildOptions, deps: DepsResult, host: BuildHost, std: string): PlanInput {
  const packages = deps.packages.map(p => {
    const dir = p.dir ?? `/deps/${p.name}-${p.version}`;
    const has = vfs.exists(`${dir}/Cargo.toml`);
    return {
      name: p.name, version: p.version, source: p.source, dir, deps: p.deps,
      // Path packages: the manifest after workspace inheritance.
      manifest: deps.manifests?.[dir] ?? (has ? vfs.readText(`${dir}/Cargo.toml`) : null),
      files: !has ? [] : p.dir ? packageFiles(vfs, dir) : filesBelow(vfs, dir).map(f => f.slice(dir.length + 1)),
    };
  });
  return {
    packages, roots: deps.workspace?.default_members, resolver: deps.workspace?.resolver,
    target: TARGET, host: TARGET, target_flag_for_host: true, target_dir: opts.targetDir ?? '/target',
    rustc_id: host.rustcId, features: opts.features, default_features: opts.defaultFeatures ?? true,
    // cargo's dev profile, but without debug info (WP-27): DWARF costs 45% of a warm edit → run of
    // the 500-line benchmark (2.0 → 1.1 s), and nothing here reads it yet (panics take file:line
    // from Location; wasm32-wasip1 has no symbolized backtraces; no debugger). Incremental needs
    // file locks in rustc on WASI (docs/incremental.md).
    profile: { incremental: false, debuginfo: 0, ...opts.profile },
    tools: { rustc: '/sysroot/bin/rustc', jobs: host.workers },
    proc_macro_args: PROC_MACRO_ARGS,
    host_args: ['--extern', `std=${std}`], test: opts.test, check: opts.check,
    build_script_args: BUILD_SCRIPT_ARGS,
  };
}

/**
 * Build scripts link the build-script std's constructor and stat wrappers (bs-std/lib.rs): `-u`
 * pulls in its object, `--wrap` sends libc's stat calls through it.
 */
const BUILD_SCRIPT_ARGS = ['--undefined=__bs_std_init', ...['stat', 'lstat', 'fstat', 'fstatat'].map(f => `--wrap=${f}`)]
  .flatMap(a => ['-C', `link-arg=${a}`]);

/**
 * The build-script std as a unit: its rlib at `<target>/bs-std/`, named by a hash of its source,
 * from the cache or compiled (once, before the first host-side compile needs it).
 */
async function hostStd(host: BuildHost, opts: BuildOptions) {
  const dir = `${opts.targetDir ?? '/target'}/bs-std`;
  const h = (await sha256(BS_STD)).slice(0, 16);
  const src = `${dir}/lib.rs`, path = `${dir}/libstd-${h}.rlib`;
  const args = ['--crate-name', 'std', '--edition=2024', src, '--crate-type', 'rlib', '--emit=link', '-C', `metadata=bs-std-${h}`,
    '-C', 'codegen-units=1', '-C', 'debuginfo=0', '--cap-lints', 'allow', '--target', TARGET, '-o', path];
  const key = await unitKey({ rustcId: host.rustcId, kind: 'bs-std', args, env: {}, source: `bs-std:${h}`, deps: [] });
  let ready: Promise<void> | undefined;
  return {
    path,
    ready: () => ready ??= (async () => {
      if (host.vfs.exists(path)) return;
      const hit = await opts.units?.get(key);
      if (hit) {
        for (const f of hit.bundle.files) host.vfs.writeFile(f.path, f.data);
        return;
      }
      host.vfs.mkdirAll(dir);
      host.vfs.writeFile(src, BS_STD);
      const r = await host.rustc(args, {});
      if (r.code !== 0) throw new Error(`the build-script std didn't compile:\n${rendered(r.stderr)}`);
      await opts.units?.put(key, await makeBundle([[path, host.vfs.readFile(path)]]));
    })(),
  };
}

/**
 * Proc macros are wasm32-wasip1 modules that web/wasi/proc-macro.ts drives inside rustc.wasm
 * (WP-20). The host needs `_initialize` (crt1-reactor.o: rustc links no crt into this crate type),
 * the function table and the allocator exported. `-C save-temps`: the module links rustc's
 * metadata object from a temp dir, and the orchestrator links after rustc returned.
 */
const PROC_MACRO_ARGS = [
  `link-arg=/sysroot/lib/rustlib/${TARGET}/lib/self-contained/crt1-reactor.o`,
  'link-arg=--export=_initialize', 'link-arg=--export-table', 'link-arg=--growable-table',
  'link-arg=--export=malloc', 'link-arg=--export=free', 'link-arg=--export=realloc', 'save-temps',
].flatMap(a => ['-C', a]);

/** Directories that a project walk skips: build output and hidden ones (.git, ...). */
const skipDir = (name: string) => name === 'target' || name.startsWith('.');

/** Every Cargo.toml below `project` (by directory), for the resolver's workspace loader. */
export function projectManifests(vfs: BuildFs, project: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of vfs.readdir(dir)) {
      if (e.kind === Kind.Dir && !skipDir(e.name)) walk(`${dir}/${e.name}`);
      else if (e.kind === Kind.File && e.name === 'Cargo.toml') out[dir] = vfs.readText(`${dir}/Cargo.toml`);
    }
  };
  walk(project);
  return out;
}

/** A path package's own files (relative): not those of packages nested in it, nor target/. */
export function packageFiles(vfs: BuildFs, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of vfs.readdir(d)) {
      const p = `${d}/${e.name}`, r = rel ? `${rel}/${e.name}` : e.name;
      if (e.kind === Kind.Dir) {
        if (!skipDir(e.name) && !vfs.exists(`${p}/Cargo.toml`)) walk(p, r);
      } else if (e.kind === Kind.File) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

export function filesBelow(vfs: BuildFs, dir: string): string[] {
  return vfs.readdir(dir).flatMap(e => {
    const p = `${dir}/${e.name}`;
    return e.kind === Kind.Dir ? filesBelow(vfs, p) : e.kind === Kind.File ? [p] : [];
  });
}

async function compile(host: BuildHost, resolver: Resolver, u: PlanUnit, outputs: Record<number, string>) {
  const f = resolver.finish(u.id, outputs);
  const at = f.args.indexOf('--out-dir');
  host.vfs.mkdirAll(f.args[at + 1]);
  const r = await host.rustc(f.args, f.env);
  const diagnostics = parseDiagnostics(r.stderr);
  if (r.code !== 0) throw new UnitError(`error: could not compile \`${u.name}\` (${u.kind}) due to errors\n${rendered(r.stderr)}`, diagnostics);
  const bundle = await makeBundle(u.outputs.map(p => [p, host.vfs.readFile(p)]), undefined, diagnostics);
  // Registry crates build with --cap-lints allow, so in practice these are the path packages'.
  return { rustcMs: r.ms.rustc, warnings: f.warnings, bundle, diagnostics };
}

/** rustc's JSON diagnostics → their rendered text (other lines as they are). */
function rendered(stderr: string) {
  return stderr.split('\n').map(l => {
    if (!l.startsWith('{')) return l;
    try { const d = JSON.parse(l); return d.rendered ?? ''; } catch { return l; }
  }).filter(Boolean).join('\n');
}

async function runBuildScript(host: BuildHost, resolver: Resolver, u: PlanUnit, outputs: Record<number, string>) {
  const f = resolver.finish(u.id, outputs);
  const outDir = u.out_dir!;
  // rustc probes write here too (autocfg's --emit=llvm-ir); the bundle has only what the script left.
  if (host.vfs.exists(outDir)) host.vfs.removeAll(outDir);
  host.vfs.mkdirAll(outDir);
  const call = async (req: Uint8Array) => encodeSpawnResult(await runSpawn(decodeSpawn(req), async (args, env, io) => {
    const r = await host.rustc(args, env, io);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr };
  }));
  const r = await host.runScript({ program: u.program!, args: [u.program!], env: Object.entries(f.env).map(([k, v]) => `${k}=${v}`), pkgDir: u.cwd!, outDir, call });
  if (r.code !== 0) {
    throw new UnitError(`error: failed to run custom build command for \`${u.name} v${u.version}\` (exit ${r.code}${r.trap ? `, ${r.trap}` : ''})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
  }
  const files = Object.entries(r.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const bundle = await makeBundle(files, r.stdout);
  if (host.vfs.exists(outDir)) host.vfs.removeAll(outDir);
  restore(host.vfs, u, bundle, outputs);
  return { warnings: [] as string[], bundle, rustcMs: undefined, diagnostics: undefined };
}

/** A build script on the override list: its listed output instead of a run. */
async function overrideBuildScript(host: BuildHost, u: PlanUnit, o: Override, outputs: Record<number, string>) {
  const bundle = await makeBundle(Object.entries(o.files ?? {}).map(([p, d]) => [`${u.out_dir}/${p}`, new TextEncoder().encode(d)]), o.stdout.replaceAll('$OUT_DIR', u.out_dir!));
  restore(host.vfs, u, bundle, outputs);
  return { warnings: [] as string[], bundle, rustcMs: undefined, diagnostics: undefined };
}

export type { Plan };
