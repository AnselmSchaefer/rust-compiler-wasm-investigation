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
// Paths: the project at `project` (a package or a workspace, WP-25), crates under
// /deps/<name>-<version>/, outputs under /target/ (shared by all projects) in cargo's layout.

import { fetchDependencies, type DepsOptions, type DepsResult } from '../deps/deps';
import type { Plan, PlanInput, PlanUnit, Resolver } from '../deps/resolver';
import { Kind, type Vfs } from '../vfs/vfs';
import { type Bundle, type CacheLevel, makeBundle, sourceId, type UnitCache, unitKey } from './cache';

/** The files a build touches: the orchestrator's VFS, or a directory on disk (tools/prebuild). */
export type BuildFs = Pick<Vfs, 'exists' | 'readFile' | 'readText' | 'writeFile' | 'readdir' | 'mkdirAll'>;

/** Where units run: the browser (browser-host.ts) or wasmtime (tools/prebuild). */
export interface BuildHost {
  vfs: BuildFs;
  rustcId: string;
  workers: number;
  /** rustc with these args and env, linking if needed; outputs land where the args say. */
  rustc(args: string[], env: Record<string, string>): Promise<{ code: number; stderr: string; ms: { rustc: number } }>;
  /** A build script (wasm32-wasip1) with its package dir readable and an empty `outDir`; returns OUT_DIR's files. */
  runScript(o: { program: string; args: string[]; env: string[]; pkgDir: string; outDir: string }):
    Promise<{ code: number | null; trap?: string; stdout: string; stderr: string; files: Record<string, Uint8Array> }>;
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
  defaultFeatures?: boolean;
  /** Overrides of cargo's dev profile. Default: no incremental (WP-27). */
  profile?: PlanInput['profile'];
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
  warnings: string[];
}

export interface BuildResult {
  ok: boolean;
  /** bin name → executable in the VFS. */
  bins: Record<string, string>;
  /** Diagnostics of the failed unit(s). */
  errors: string;
  units: UnitReport[];
  /** Planned units that weren't needed: everything that depends on them was a cache hit. */
  skipped: number;
  packages: number;
  workers: number;
  cache: UnitCache['stats'] | null;
  ms: { deps: number; plan: number; build: number; store: number; total: number };
}

const TARGET = 'wasm32-wasip1';

class UnitError extends Error {}

/** Per VFS: unit key → its outputs, already in place from an earlier build in this session. */
const inPlace = new WeakMap<object, Map<string, { files: Record<string, string>; stdout?: string }>>();

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
  const input = planInput(vfs, opts, deps, host);
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
        .then(([src, dk]) => unitKey({ rustcId: host.rustcId, kind: u.kind, args: u.args, env: u.env, source: src, deps: dk })));
    }
    return k;
  };

  const closure = (u: PlanUnit, seen = new Set<number>()): Set<number> => {
    for (const d of u.deps) if (!seen.has(d)) { seen.add(d); closure(plan.units[d], seen); }
    return seen;
  };

  const units: UnitReport[] = [];
  const outputs: Record<number, string> = {};
  const errors: string[] = [];
  const stores: Promise<void>[] = [];
  const done = new Map<number, Promise<void>>();
  const unit = (u: PlanUnit): Promise<void> => {
    let p = done.get(u.id);
    if (!p) {
      p = (async () => {
        const key = await keyOf(u);
        let start = performance.now() - t0;
        const report = (r: { cached?: UnitReport['cached']; rustcMs?: number; files: Record<string, string>; warnings: string[] }) => {
          const rep = { id: u.id, name: u.name, version: u.version, kind: u.kind, key, start: Math.round(start), end: Math.round(performance.now() - t0), ...r };
          units.push(rep);
          opts.onUnit?.(rep);
        };
        const here = fresh.get(key);
        if (here && Object.keys(here.files).every(f => vfs.exists(f))) {
          if (here.stdout !== undefined) outputs[u.id] = here.stdout;
          return report({ cached: 'fresh', files: here.files, warnings: [] });
        }
        const hit = await opts.units?.get(key);
        if (hit) {
          restore(vfs, u, hit.bundle, outputs);
          const files = hashes(hit.bundle);
          fresh.set(key, { files, stdout: hit.bundle.stdout });
          return report({ cached: hit.from, files, warnings: [] });
        }
        // rustc reads the dependencies' dependencies too (-L dependency=), so a miss needs the
        // whole closure in place; a hit above didn't put its own dependencies there.
        await Promise.all([...closure(u)].map(d => unit(plan.units[d])));
        start = performance.now() - t0;
        const r = u.kind === 'run-custom-build' ? await runBuildScript(host, opts.resolver, u, outputs) : await compile(host, opts.resolver, u, outputs);
        const files = hashes(r.bundle);
        fresh.set(key, { files, stdout: r.bundle.stdout });
        if (opts.units) stores.push(opts.units.put(key, r.bundle));
        report({ rustcMs: r.rustcMs, files, warnings: r.warnings });
      })().catch(e => {
        if (e instanceof UnitError) errors.push(e.message);
        throw e;
      });
      done.set(u.id, p);
    }
    return p;
  };
  const roots = plan.bins.map(([, id]) => plan.units[id]);
  const results = await Promise.allSettled((roots.length ? roots : plan.units).map(unit));
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed && !(failed.reason instanceof UnitError)) throw failed.reason;

  const bins: Record<string, string> = {};
  if (!failed) {
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
    ok: !failed, bins, errors: [...new Set(errors)].join('\n'), units: units.sort((a, b) => a.start - b.start), skipped: plan.units.length - units.length,
    packages: deps.packages.length, workers: host.workers, cache: opts.units?.stats ?? null,
    ms: { deps: Math.round(t1 - t0), plan: Math.round(t2 - t1), build: Math.round(t3 - t2), store: Math.round(t4 - t3), total: Math.round(t4 - t0) },
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

function planInput(vfs: BuildFs, opts: BuildOptions, deps: DepsResult, host: BuildHost): PlanInput {
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
    profile: { incremental: false, ...opts.profile },
    tools: { rustc: '/sysroot/bin/rustc', jobs: host.workers },
    proc_macro_args: PROC_MACRO_ARGS,
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
  if (r.code !== 0) throw new UnitError(`error: could not compile \`${u.name}\` (${u.kind}) due to errors\n${rendered(r.stderr)}`);
  const bundle = await makeBundle(u.outputs.map(p => [p, host.vfs.readFile(p)]));
  return { rustcMs: r.ms.rustc, warnings: f.warnings, bundle };
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
  const r = await host.runScript({ program: u.program!, args: [u.program!], env: Object.entries(f.env).map(([k, v]) => `${k}=${v}`), pkgDir: u.cwd!, outDir });
  if (r.code !== 0) {
    throw new UnitError(`error: failed to run custom build command for \`${u.name} v${u.version}\` (exit ${r.code}${r.trap ? `, ${r.trap}` : ''})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
  }
  const files = Object.entries(r.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const bundle = await makeBundle(files, r.stdout);
  restore(host.vfs, u, bundle, outputs);
  return { warnings: [] as string[], bundle, rustcMs: undefined };
}

export type { Plan };
