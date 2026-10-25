// `cargo build` in the browser (WP-17): resolve and fetch the dependencies (web/deps), plan the
// units (the planner in crates/resolver), then run them on the orchestrator: each unit as soon as
// its dependencies are done, compiles on up to `workers` compile servers at once. Build scripts
// are wasm32-wasip1 programs; each runs in the run sandbox with a copy of its package's files,
// cargo's environment and an empty OUT_DIR, which is copied back. Their `cargo:` output goes
// into the package's rustc invocation (`Resolver.finish`).
//
// Runs where the orchestrator runs (its worker). Paths: the project at `project`, crates under
// /deps/<name>-<version>/, outputs under <project>/target/ in cargo's layout.

import type { Orchestrator } from '../orchestrator/orchestrator';
import { fetchDependencies, type DepsOptions, type DepsResult } from '../deps/deps';
import type { Plan, PlanInput, PlanUnit, Resolver } from '../deps/resolver';
import { runSandboxed } from '../sandbox/sandbox';
import { Kind, type Vfs } from '../vfs/vfs';

export interface BuildOptions {
  /** Directory with Cargo.toml and src/. */
  project: string;
  resolver: Resolver;
  /** Sparse-index base URL (ending in '/') and crate download base. */
  index: string;
  dl?: string;
  cache?: DepsOptions['cache'];
  features?: string[];
  defaultFeatures?: boolean;
  /** Overrides of cargo's dev profile. Default: no incremental (WP-27). */
  profile?: PlanInput['profile'];
  sandbox: { workerUrl: string; vfsUrl: string };
  onUnit?: (u: UnitReport) => void;
}

export interface UnitReport {
  id: number; name: string; version: string; kind: PlanUnit['kind'];
  /** ms since the build started. */
  start: number; end: number;
  /** rustc's ms (compile units). */
  rustcMs?: number;
  warnings: string[];
}

export interface BuildResult {
  ok: boolean;
  /** bin name → executable in the VFS. */
  bins: Record<string, string>;
  /** Diagnostics of the failed unit(s). */
  errors: string;
  units: UnitReport[];
  packages: number;
  workers: number;
  ms: { deps: number; plan: number; build: number; total: number };
}

const TARGET = 'wasm32-wasip1';

class UnitError extends Error {}

export async function cargoBuild(orch: Orchestrator, opts: BuildOptions): Promise<BuildResult> {
  const t0 = performance.now();
  const vfs = orch.vfs;
  const manifest = vfs.readText(`${opts.project}/Cargo.toml`);
  const deps = await fetchDependencies(manifest, vfs, { resolver: opts.resolver, index: opts.index, dl: opts.dl, cache: opts.cache, dir: '/deps' });
  const t1 = performance.now();
  const plan = opts.resolver.plan(planInput(vfs, opts, deps, orch));
  const t2 = performance.now();

  const units: UnitReport[] = [];
  const outputs: Record<number, string> = {};
  const errors: string[] = [];
  const done = new Map<number, Promise<void>>();
  const unit = (u: PlanUnit): Promise<void> => {
    let p = done.get(u.id);
    if (!p) {
      p = Promise.all(u.deps.map(d => unit(plan.units[d]))).then(async () => {
        const start = performance.now() - t0;
        const r = u.kind === 'run-custom-build' ? await runBuildScript(vfs, opts, u, outputs) : await compile(orch, opts.resolver, u, outputs);
        const report = { id: u.id, name: u.name, version: u.version, kind: u.kind, start: Math.round(start), end: Math.round(performance.now() - t0), ...r };
        units.push(report);
        opts.onUnit?.(report);
      }).catch(e => {
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
  return {
    ok: !failed, bins, errors: [...new Set(errors)].join('\n'), units: units.sort((a, b) => a.start - b.start),
    packages: deps.packages.length, workers: orch.workers,
    ms: { deps: Math.round(t1 - t0), plan: Math.round(t2 - t1), build: Math.round(t3 - t2), total: Math.round(t3 - t0) },
  };
}

function planInput(vfs: Vfs, opts: BuildOptions, deps: DepsResult, orch: Orchestrator): PlanInput {
  const packages = deps.packages.map(p => {
    const dir = p.source === 'path' ? opts.project : `/deps/${p.name}-${p.version}`;
    const has = vfs.exists(`${dir}/Cargo.toml`);
    return {
      name: p.name, version: p.version, source: p.source, dir, deps: p.deps,
      manifest: has ? vfs.readText(`${dir}/Cargo.toml`) : null,
      files: has ? filesBelow(vfs, dir).map(f => f.slice(dir.length + 1)).filter(f => !f.startsWith('target/')) : [],
    };
  });
  return {
    packages, root: deps.packages.findIndex(p => p.source === 'path'),
    target: TARGET, host: TARGET, target_flag_for_host: true, target_dir: `${opts.project}/target`,
    rustc_id: orch.release.id, features: opts.features, default_features: opts.defaultFeatures ?? true,
    profile: { incremental: false, ...opts.profile },
    tools: { rustc: '/sysroot/bin/rustc', jobs: orch.workers },
  };
}

function filesBelow(vfs: Vfs, dir: string): string[] {
  return vfs.readdir(dir).flatMap(e => {
    const p = `${dir}/${e.name}`;
    return e.kind === Kind.Dir ? filesBelow(vfs, p) : e.kind === Kind.File ? [p] : [];
  });
}

async function compile(orch: Orchestrator, resolver: Resolver, u: PlanUnit, outputs: Record<number, string>) {
  const f = resolver.finish(u.id, outputs);
  const at = f.args.indexOf('--out-dir');
  orch.vfs.mkdirAll(f.args[at + 1]);
  const r = await orch.rustcJob(f.args, f.env);
  if (r.code !== 0) throw new UnitError(`error: could not compile \`${u.name}\` (${u.kind}) due to errors\n${rendered(r.stderr)}`);
  return { rustcMs: r.ms.rustc, warnings: f.warnings };
}

/** rustc's JSON diagnostics → their rendered text (other lines as they are). */
function rendered(stderr: string) {
  return stderr.split('\n').map(l => {
    if (!l.startsWith('{')) return l;
    try { const d = JSON.parse(l); return d.rendered ?? ''; } catch { return l; }
  }).filter(Boolean).join('\n');
}

async function runBuildScript(vfs: Vfs, opts: BuildOptions, u: PlanUnit, outputs: Record<number, string>) {
  const f = opts.resolver.finish(u.id, outputs);
  const pkgDir = u.cwd!, outDir = u.out_dir!;
  const files: Record<string, Uint8Array> = {};
  for (const p of filesBelow(vfs, pkgDir)) files[p] = vfs.readFile(p);
  const r = await runSandboxed({
    ...opts.sandbox, program: vfs.readFile(u.program!), args: [u.program!],
    env: Object.entries(f.env).map(([k, v]) => `${k}=${v}`), files, dirs: [outDir], collect: [`${outDir}/`],
  }).result;
  if (r.code !== 0) {
    throw new UnitError(`error: failed to run custom build command for \`${u.name} v${u.version}\` (exit ${r.code}${r.trap ? `, ${r.trap}` : ''})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
  }
  vfs.mkdirAll(outDir);
  for (const [p, data] of Object.entries(r.files)) vfs.writeFile(p, data);
  // Like cargo: the script's stdout next to OUT_DIR, for debugging.
  vfs.writeFile(`${outDir.slice(0, outDir.lastIndexOf('/'))}/output`, r.stdout);
  outputs[u.id] = r.stdout;
  return { warnings: [] as string[] };
}

export type { Plan };
