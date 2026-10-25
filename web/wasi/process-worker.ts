// Worker entry for one thread of a WASI process (see process.ts): the main thread runs `_start`,
// spawned threads run `wasi_thread_start(tid, arg)`. Posts `{ exit }` when the process ends and
// `{ idle }` when a spawned thread finishes.
import { Vfs } from '../vfs/vfs';
import { ProcExit, WasiProcess } from './wasi';
import { requestThread, stdoutWritten, type StartMessage, type ThreadMessage, type WorkerMessage } from './process';
import { procMacroImports } from './proc-macro';

let thread: ((tid: number, arg: number) => void) | undefined;

onmessage = async (e: MessageEvent<StartMessage | ThreadMessage>) => {
  // A worker whose thread has finished stays idle; the page can hand it the next thread.
  if (!('module' in e.data)) return runThread(e.data.thread);
  const { vfs: handle, module, memory, channel, pid, args, env } = e.data;
  const vfs = await Vfs.attach(handle);
  const wasi = new WasiProcess(vfs, pid, args, env, fd => { if (fd === 1) stdoutWritten(channel); });
  let inst!: WebAssembly.Instance;
  const pm = WebAssembly.Module.imports(module).some(i => i.module === 'rust_pm');
  inst = await WebAssembly.instantiate(module, {
    env: { memory },
    wasi_snapshot_preview1: wasi.imports,
    wasi: { 'thread-spawn': (arg: number) => requestThread(channel, arg) },
    // rustc-multi's Wasm proc-macro host (WP-20), per thread: macros run on rustc's thread.
    ...(pm ? { rust_pm: procMacroImports(vfs, memory, () => inst) } : {}),
  });
  wasi.setMemory(memory);
  const x = inst.exports as { _start(): void; wasi_thread_start(tid: number, arg: number): void };
  thread = x.wasi_thread_start;
  if (e.data.thread) return runThread(e.data.thread);
  try {
    x._start();
    postMessage({ exit: 0 } satisfies WorkerMessage);
  } catch (err) {
    exitWith(err);
  }
};

// wasi-libc's wasi_thread_start sets the stack pointer and TLS base from `arg` each time, so one
// instance can run one thread after another.
function runThread(t: { tid: number; arg: number }) {
  try {
    thread!(t.tid, t.arg);
    postMessage({ idle: true } satisfies WorkerMessage);
  } catch (err) {
    exitWith(err);
  }
}

// proc_exit from any thread ends the whole process; a trap does too.
function exitWith(err: unknown) {
  if (err instanceof ProcExit) postMessage({ exit: err.code } satisfies WorkerMessage);
  else postMessage({ exit: 134, error: String((err as Error)?.stack ?? err) } satisfies WorkerMessage);
}
