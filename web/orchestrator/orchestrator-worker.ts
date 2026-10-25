// Worker entry: owns the orchestrator and answers the typed requests of protocol.ts.
import { Orchestrator } from './orchestrator';
import { runSandboxed } from '../sandbox/sandbox';
import { type BuildOptions, cargoBuild } from '../build/cargo';
import { cargoClippy, cargoTest } from '../build/test';
import { browserHost } from '../build/browser-host';
import { UnitCache } from '../build/cache';
import { FileCache } from '../deps/cache';
import { Persister } from '../vfs/persist';
import { PROJECTS, deleteProject, editManifest, exportZip, importZip, listProjects, writeProject } from '../project/projects';
import { importGitHub } from '../project/github';
import { Resolver } from '../deps/resolver';
import type { Ops, Request, Response, RunOutput } from './protocol';

let orch: Orchestrator | undefined, vfsUrl: string | undefined, sandboxUrl: string | undefined;
let persister: Persister | undefined;
const resolvers = new Map<string, Promise<WebAssembly.Module>>();
/** The OPFS directory of the build cache's L1 (WP-18). */
const BUILD_CACHE = 'build-cache';
const need = () => { if (!orch) throw new Error('orchestrator: init first'); return orch; };

const handlers: { [O in keyof Ops]: (a: Ops[O]['args']) => Promise<Ops[O]['result']> | Ops[O]['result'] } = {
  async init(a) {
    const t0 = performance.now();
    orch = await Orchestrator.create(a);
    vfsUrl = a.vfsUrl;
    sandboxUrl = a.sandboxWorkerUrl ?? new URL('sandbox-worker.js', self.location.href).href;
    let projects;
    if (a.persist) {
      const p = await Persister.start(orch.vfs, PROJECTS);
      persister = p.persister;
      projects = { restored: p.restored, names: listProjects(orch.vfs) };
    }
    return { rustcId: orch.release.id, ms: Math.round(performance.now() - t0), loads: orch.release.stats, projects };
  },
  writeFile: a => need().vfs.writeFile(a.path, a.data),
  readFile: a => need().vfs.readFile(a.path),
  ls: a => need().vfs.readdir(a.path).map(e => e.name),
  rustc: a => need().rustcJob(a.args, a.env),
  async build(a) {
    return cargoBuild(host(), await buildOptions(a));
  },
  async check(a) {
    return cargoBuild(host(), { ...await buildOptions(a), check: true });
  },
  async test(a) {
    return cargoTest(host(), { ...await buildOptions(a), filter: a.filter, exact: a.exact, includeIgnored: a.includeIgnored });
  },
  async clippy(a) {
    return cargoClippy(host(), await buildOptions(a));
  },
  async fmt(a) {
    const vfs = need().vfs, src = vfs.readText(a.path), dir = a.path.slice(0, a.path.lastIndexOf('/')) || '/';
    const args = [...(a.edition ? ['--edition', a.edition] : []), ...(a.check ? ['--check'] : [])];
    const r = await need().rustfmt(src, args, dir);
    const changed = !a.check && r.exit === 0 && r.out !== src;
    if (changed) vfs.writeFile(a.path, r.out);
    return { exit: r.exit, changed, out: r.out, stderr: r.stderr, ms: r.ms };
  },
  projectList: () => listProjects(need().vfs),
  async projectImport(a) {
    const t0 = performance.now(), vfs = need().vfs, src = a.source;
    let files = 0, skipped: string[] = [];
    if ('zip' in src) files = await importZip(vfs, a.name, src.zip);
    else if ('github' in src) {
      const g = await importGitHub({ repo: src.github, subdir: src.subdir });
      files = writeProject(vfs, a.name, g.files);
      skipped = g.skipped;
    } else files = writeProject(vfs, a.name, src.files);
    return { files, skipped, ms: Math.round(performance.now() - t0) };
  },
  projectExport: a => exportZip(need().vfs, a.name),
  projectDelete: a => deleteProject(need().vfs, a.name),
  async projectFlush() {
    if (!persister) throw new Error('projectFlush: init with persist first');
    await persister.flush();
    return { flushes: persister.stats.flushes, written: persister.stats.written };
  },
  async manifestEdit(a) {
    return editManifest(need().vfs, await resolverFor(a.resolverUrl), a.project, a.dir ?? '', a.edits, { index: a.index });
  },
  run: a => runProgram(a.path, a.args ?? []),
  stats: () => need().stats(),
  close: async () => ({ code: (await need().close()).code }),
};

const host = () => browserHost(need(), { workerUrl: sandboxUrl!, vfsUrl: vfsUrl! });

async function buildOptions(a: Ops['build']['args']): Promise<BuildOptions> {
  const units = new UnitCache(a.cache?.l1 === false ? null : await FileCache.open(BUILD_CACHE), a.cache?.l2 ?? null);
  return {
    project: a.project, resolver: await resolverFor(a.resolverUrl), index: a.index, dl: a.dl, features: a.features,
    defaultFeatures: a.defaultFeatures, profile: a.profile, units, targetDir: a.targetDir,
  };
}

/** A fresh resolver instance (the planner keeps its last plan; resolve state stays small). */
async function resolverFor(url: string): Promise<Resolver> {
  let m = resolvers.get(url);
  if (!m) resolvers.set(url, m = WebAssembly.compileStreaming(fetch(url)));
  return Resolver.instantiate(await m);
}

onmessage = async (e: MessageEvent<Request>) => {
  const { id, op, args } = e.data;
  try {
    const result = await (handlers[op] as (a: unknown) => unknown)(args);
    postMessage({ id, ok: true, result } satisfies Response);
  } catch (err) {
    postMessage({ id, ok: false, error: String((err as Error)?.stack ?? err) } satisfies Response);
  }
};

/** A wasm32-wasip1 program from the VFS, in the run sandbox (a worker of its own). */
async function runProgram(path: string, args: string[]): Promise<RunOutput> {
  const r = await runSandboxed({
    workerUrl: sandboxUrl!, vfsUrl: vfsUrl!, program: need().vfs.readFile(path), args: [path, ...args],
  }).result;
  return { code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr, ms: r.ms };
}
