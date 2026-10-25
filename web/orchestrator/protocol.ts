// Messages between a page (client.ts) and the orchestrator worker (orchestrator-worker.ts).
import type { RustcResult } from './orchestrator';
import type { LoadStats } from './toolchain';
import type { BuildResult } from '../build/cargo';
import type { ClippyRun, TestRun } from '../build/test';
import type { ManifestEdit, PlanInput } from '../deps/resolver';
import type { EditResult } from '../project/projects';

export interface InitResult { rustcId: string; ms: number; loads: LoadStats[]; projects?: { restored: number; names: string[] } }

/** Where a project comes from (web/project): files, a zip, or a public GitHub repository. */
export type ProjectSource =
  | { files: Record<string, string | Uint8Array> }
  | { zip: Uint8Array }
  | { github: string; subdir?: string };
export interface RunOutput { code: number; stdout: string; stderr: string; ms: number }

/** Each request names its operation; the answer type is in `Ops`. */
export type Ops = {
  /** `workers`: compile servers at most (parallel rustc jobs; default 1). */
  /** `persist` (WP-25): restore /projects from OPFS and keep mirroring it there. */
  init: { args: { releaseUrl: string; vfsUrl: string; workerUrl: string; sandboxWorkerUrl?: string; workers?: number; persist?: boolean }; result: InitResult };
  writeFile: { args: { path: string; data: string | Uint8Array }; result: void };
  readFile: { args: { path: string }; result: Uint8Array };
  ls: { args: { path: string }; result: string[] };
  rustc: { args: { args: string[]; env?: Record<string, string> }; result: RustcResult };
  /**
   * `cargo build` of the project in `project` (WP-17): dependencies from `index` (sparse index)
   * and `dl`, planned by the resolver module at `resolverUrl`; see web/build/cargo.ts.
   * `cache` (WP-18): `l1` (default true) keeps built units in OPFS; `l2` is a read-only cache's base URL.
   */
  build: {
    args: {
      project: string; resolverUrl: string; index: string; dl?: string; features?: string[]; defaultFeatures?: boolean; profile?: PlanInput['profile'];
      cache?: { l1?: boolean; l2?: string }; targetDir?: string;
    };
    result: BuildResult;
  };
  /**
   * `cargo test` (WP-26; web/build/test.ts): every test in a process of its own, results per test.
   * `filter` (+ `exact`): only the tests whose name contains (equals) it.
   */
  test: { args: Ops['build']['args'] & { filter?: string; exact?: boolean; includeIgnored?: boolean }; result: TestRun };
  /** `cargo clippy` (WP-26): the primary packages' diagnostics, Clippy's lints included. */
  clippy: { args: Ops['build']['args']; result: ClippyRun };
  /**
   * rustfmt (WP-26) on a file, in place; rustfmt.toml from the file's directory up. `check`: only
   * report (a diff in `out`, exit 1 if the file isn't formatted).
   */
  fmt: { args: { path: string; edition?: string; check?: boolean }; result: { exit: number; changed: boolean; out: string; stderr: string; ms: number } };
  /** Projects (WP-25) live at /projects/<name>; build one with `build` and that path. */
  projectList: { args: Record<string, never>; result: string[] };
  projectImport: { args: { name: string; source: ProjectSource }; result: { files: number; skipped: string[]; ms: number } };
  projectExport: { args: { name: string }; result: Uint8Array };
  projectDelete: { args: { name: string }; result: void };
  /** Wait until every change so far is in OPFS (before a reload). */
  projectFlush: { args: Record<string, never>; result: { flushes: number; written: number } };
  /** Edit a Cargo.toml (`dir` relative to the project) and resolve: lockfile changes, or the error. */
  manifestEdit: { args: { project: string; dir?: string; edits: ManifestEdit[]; resolverUrl: string; index: string }; result: EditResult };
  /** Run a wasm32-wasip1 program from the VFS in the run sandbox (no stdin; see web/sandbox for more). */
  run: { args: { path: string; args?: string[] }; result: RunOutput };
  /** Sizes of the big memories: the VFS and the compile server's rustc instance (both only grow). */
  stats: { args: Record<string, never>; result: { vfsBytes: number; rustcBytes: number; jobs: number; servers: number } };
  close: { args: Record<string, never>; result: { code: number } };
};
export type Op = keyof Ops;
export type Request<O extends Op = Op> = { id: number; op: O; args: Ops[O]['args'] };
export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
