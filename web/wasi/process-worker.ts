// Worker entry for one thread of a WASI process (see process.ts): the main thread runs `_start`,
// spawned threads run `wasi_thread_start(tid, arg)`. Posts `{ exit }` when the process ends.
import { Vfs } from '../vfs/vfs';
import { ProcExit, WasiProcess } from './wasi';
import { requestThread, type StartMessage } from './process';

onmessage = async (e: MessageEvent<StartMessage>) => {
  const { vfs: handle, module, memory, channel, pid, args, env, thread } = e.data;
  const vfs = await Vfs.attach(handle);
  const wasi = new WasiProcess(vfs, pid, args, env);
  const inst = await WebAssembly.instantiate(module, {
    env: { memory },
    wasi_snapshot_preview1: wasi.imports,
    wasi: { 'thread-spawn': (arg: number) => requestThread(channel, arg) },
  });
  wasi.setMemory(memory);
  const x = inst.exports as { _start(): void; wasi_thread_start(tid: number, arg: number): void };
  try {
    if (thread) {
      x.wasi_thread_start(thread.tid, thread.arg);
      close(); // thread finished; the process goes on
      return;
    }
    x._start();
    postMessage({ exit: 0 });
  } catch (err) {
    // proc_exit from any thread ends the whole process; a trap does too.
    if (err instanceof ProcExit) postMessage({ exit: err.code });
    else postMessage({ exit: 134, error: String((err as Error)?.stack ?? err) });
  }
};
