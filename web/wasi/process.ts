// Run a WASI (wasip1-threads) program on the shared VFS: the main thread in one worker, each
// `wasi.thread-spawn` in another (WP-11). A worker whose thread has finished is kept, with its
// instance, and runs the process's next thread (WP-09): rustc starts a thread per compilation, and
// a new worker means instantiating the whole compiler again.
//
// Thread creation: a thread that calls thread-spawn usually blocks right after (join), and a
// blocked worker cannot start a nested worker. So spawn requests go through a ring buffer in a
// SharedArrayBuffer to the page (which never blocks), and the page starts the worker.

import { createProcess, freeProcess, type ProcessSpec } from './wasi';
import type { Vfs, VfsHandle } from '../vfs/vfs';

// Channel layout (Int32Array): [SEQ, NEXT_TID, CLAIM, OUT_SEQ, READY × N, (tid, arg) × N].
// OUT_SEQ counts writes to stdout, so the page can wait for output instead of polling.
const SEQ = 0, NEXT_TID = 1, CLAIM = 2, OUT_SEQ = 3, READY = 4, N = 256, DATA = READY + N;
export const CHANNEL_INTS = DATA + 2 * N;

/** Called from any thread of the process: queue a thread and return its id (wasi-threads ABI). */
export function requestThread(ch: Int32Array, startArg: number): number {
  const tid = Atomics.add(ch, NEXT_TID, 1);
  const slot = Atomics.add(ch, CLAIM, 1) % N;
  if (Atomics.load(ch, READY + slot) !== 0) return -6; // EAGAIN: ring full
  ch[DATA + 2 * slot] = tid;
  ch[DATA + 2 * slot + 1] = startArg;
  Atomics.store(ch, READY + slot, 1);
  Atomics.add(ch, SEQ, 1);
  Atomics.notify(ch, SEQ);
  return tid;
}

/** Called by the process's threads after a write to stdout. */
export function stdoutWritten(ch: Int32Array) {
  Atomics.add(ch, OUT_SEQ, 1);
  Atomics.notify(ch, OUT_SEQ);
}

/** Message to process-worker.ts. */
export type StartMessage = {
  vfs: VfsHandle; module: WebAssembly.Module; memory: WebAssembly.Memory; channel: Int32Array;
  pid: number; args: string[]; env: string[];
  thread?: { tid: number; arg: number };
};

/** Message to an idle process-worker.ts: run another thread of the same process. */
export type ThreadMessage = { thread: { tid: number; arg: number } };

/** Message from process-worker.ts: the process exited, or a spawned thread finished (`idle`). */
export type WorkerMessage = { exit: number; error?: string } | { idle: true };

export type RunResult = { code: number; error?: string; threads: number; workers: number; ms: number };

/** Memory limits from a module's `env.memory` import (wasm binary import section). */
export function importedMemoryLimits(bytes: Uint8Array): { initial: number; maximum: number } {
  let o = 8;
  const leb = () => { let r = 0, s = 0, b; do { b = bytes[o++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  const name = () => { const l = leb(); o += l; };
  while (o < bytes.length) {
    const id = bytes[o++], size = leb(), end = o + size;
    if (id === 2) {
      for (let n = leb(); n > 0; n--) {
        name(); name();
        const kind = bytes[o++];
        if (kind === 0) leb();
        else if (kind === 1) { o++; const f = leb(); leb(); if (f & 1) leb(); }
        else if (kind === 3) o += 2;
        else if (kind === 4) { o++; leb(); }
        else if (kind === 2) {
          const flags = leb(), initial = leb(), maximum = flags & 1 ? leb() : 65536;
          return { initial, maximum };
        }
      }
    }
    o = end;
  }
  throw new Error('module does not import a memory');
}

/**
 * Start `module` as a process with `spec` and wait for it to exit. `vfs` is the caller's own
 * attachment (the page's); `handle` is passed to the workers. `onStdout` is called (on the page)
 * after the process has written to stdout, at most once per page task.
 */
export async function runProcess(
  vfs: Vfs, handle: VfsHandle, module: WebAssembly.Module, memory: WebAssembly.Memory, spec: ProcessSpec,
  workerUrl: string | URL, onStdout?: () => void,
): Promise<RunResult> {
  const t0 = performance.now();
  const pid = createProcess(vfs, spec);
  const channel = new Int32Array(new SharedArrayBuffer(CHANNEL_INTS * 4));
  channel[NEXT_TID] = 1;
  const base: StartMessage = { vfs: handle, module, memory, channel, pid, args: spec.args, env: spec.env };
  const workers: Worker[] = [], idle: Worker[] = [];
  let done = false, threads = 0;

  const result = new Promise<RunResult>(resolve => {
    const finish = (code: number, error?: string) => {
      if (done) return;
      done = true;
      for (const w of workers) w.terminate();
      freeProcess(vfs, pid);
      resolve({ code, error, threads, workers: workers.length, ms: Math.round(performance.now() - t0) });
    };
    const start = (thread?: StartMessage['thread']) => {
      const reuse = thread && idle.pop();
      if (reuse) {
        reuse.postMessage({ thread } satisfies ThreadMessage);
        return;
      }
      const w = new Worker(workerUrl, { type: 'module' });
      workers.push(w);
      w.onmessage = (e: MessageEvent<WorkerMessage>) => {
        if ('exit' in e.data) finish(e.data.exit, e.data.error);
        else idle.push(w);
      };
      w.onerror = e => finish(-1, `worker error: ${e.message}`);
      w.postMessage({ ...base, thread } satisfies StartMessage);
    };

    // Spawner: drain the ring whenever SEQ moves.
    let tail = 0;
    (async () => {
      let seen = 0;
      while (!done) {
        for (let slot = tail % N; Atomics.load(channel, READY + slot) === 1; slot = tail % N) {
          const tid = channel[DATA + 2 * slot], arg = channel[DATA + 2 * slot + 1];
          Atomics.store(channel, READY + slot, 0);
          tail++;
          threads++;
          start({ tid, arg });
        }
        const w = Atomics.waitAsync(channel, SEQ, seen, 1000);
        if (w.async) await w.value;
        seen = Atomics.load(channel, SEQ);
      }
    })();

    if (onStdout) (async () => {
      let seen = 0;
      while (!done) {
        const w = Atomics.waitAsync(channel, OUT_SEQ, seen, 1000);
        if (w.async) await w.value;
        const now = Atomics.load(channel, OUT_SEQ);
        if (now !== seen && !done) onStdout();
        seen = now;
      }
    })();

    start();
  });
  return result;
}
