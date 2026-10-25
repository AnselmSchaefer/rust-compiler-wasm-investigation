// Messages between a page (client.ts) and the orchestrator worker (orchestrator-worker.ts).
import type { RustcResult } from './orchestrator';
import type { LoadStats } from './toolchain';
import type { BuildResult } from '../build/cargo';
import type { PlanInput } from '../deps/resolver';

export interface InitResult { rustcId: string; ms: number; loads: LoadStats[] }
export interface RunOutput { code: number; stdout: string; stderr: string; ms: number }

/** Each request names its operation; the answer type is in `Ops`. */
export type Ops = {
  /** `workers`: compile servers at most (parallel rustc jobs; default 1). */
  init: { args: { releaseUrl: string; vfsUrl: string; workerUrl: string; sandboxWorkerUrl?: string; workers?: number }; result: InitResult };
  writeFile: { args: { path: string; data: string | Uint8Array }; result: void };
  readFile: { args: { path: string }; result: Uint8Array };
  ls: { args: { path: string }; result: string[] };
  rustc: { args: { args: string[]; env?: Record<string, string> }; result: RustcResult };
  /**
   * `cargo build` of the project in `project` (WP-17): dependencies from `index` (sparse index)
   * and `dl`, planned by the resolver module at `resolverUrl`; see web/build/cargo.ts.
   */
  build: {
    args: { project: string; resolverUrl: string; index: string; dl?: string; features?: string[]; defaultFeatures?: boolean; profile?: PlanInput['profile'] };
    result: BuildResult;
  };
  /** Run a wasm32-wasip1 program from the VFS in the run sandbox (no stdin; see web/sandbox for more). */
  run: { args: { path: string; args?: string[] }; result: RunOutput };
  /** Sizes of the big memories: the VFS and the compile server's rustc instance (both only grow). */
  stats: { args: Record<string, never>; result: { vfsBytes: number; rustcBytes: number; jobs: number; servers: number } };
  close: { args: Record<string, never>; result: { code: number } };
};
export type Op = keyof Ops;
export type Request<O extends Op = Op> = { id: number; op: O; args: Ops[O]['args'] };
export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
