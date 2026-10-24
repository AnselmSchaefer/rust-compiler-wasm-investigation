// Messages between a page (client.ts) and the orchestrator worker (orchestrator-worker.ts).
import type { RustcResult } from './orchestrator';
import type { LoadStats } from './toolchain';

export interface InitResult { rustcId: string; ms: number; loads: LoadStats[] }
export interface RunOutput { code: number; stdout: string; stderr: string; ms: number }

/** Each request names its operation; the answer type is in `Ops`. */
export type Ops = {
  init: { args: { releaseUrl: string; vfsUrl: string; workerUrl: string; sandboxWorkerUrl?: string }; result: InitResult };
  writeFile: { args: { path: string; data: string | Uint8Array }; result: void };
  readFile: { args: { path: string }; result: Uint8Array };
  ls: { args: { path: string }; result: string[] };
  rustc: { args: { args: string[] }; result: RustcResult };
  /** Run a wasm32-wasip1 program from the VFS in the run sandbox (no stdin; see web/sandbox for more). */
  run: { args: { path: string; args?: string[] }; result: RunOutput };
  close: { args: Record<string, never>; result: { code: number } };
};
export type Op = keyof Ops;
export type Request<O extends Op = Op> = { id: number; op: O; args: Ops[O]['args'] };
export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
