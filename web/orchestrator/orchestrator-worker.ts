// Worker entry: owns the orchestrator and answers the typed requests of protocol.ts.
import { Orchestrator } from './orchestrator';
import { createProcess, freeProcess, ProcExit, WasiProcess } from '../wasi/wasi';
import type { Ops, Request, Response, RunOutput } from './protocol';

let orch: Orchestrator | undefined;
const need = () => { if (!orch) throw new Error('orchestrator: init first'); return orch; };

const handlers: { [O in keyof Ops]: (a: Ops[O]['args']) => Promise<Ops[O]['result']> | Ops[O]['result'] } = {
  async init(a) {
    const t0 = performance.now();
    orch = await Orchestrator.create(a);
    return { rustcId: orch.release.id, ms: Math.round(performance.now() - t0), loads: orch.release.stats };
  },
  writeFile: a => need().vfs.writeFile(a.path, a.data),
  readFile: a => need().vfs.readFile(a.path),
  ls: a => need().vfs.readdir(a.path).map(e => e.name),
  rustc: a => need().rustcJob(a.args),
  run: a => runProgram(a.path, a.args ?? []),
  close: async () => ({ code: (await need().close()).code }),
};

onmessage = async (e: MessageEvent<Request>) => {
  const { id, op, args } = e.data;
  try {
    const result = await (handlers[op] as (a: unknown) => unknown)(args);
    postMessage({ id, ok: true, result } satisfies Response);
  } catch (err) {
    postMessage({ id, ok: false, error: String((err as Error)?.stack ?? err) } satisfies Response);
  }
};

/** A non-threaded wasip1 program, on this worker's thread. */
async function runProgram(path: string, args: string[]): Promise<RunOutput> {
  const vfs = need().vfs, t0 = performance.now();
  const out = '/proc/run.out', err = '/proc/run.err';
  vfs.writeFile(out, '');
  vfs.writeFile(err, '');
  const argv = [path, ...args];
  const pid = createProcess(vfs, { args: argv, env: [], stdout: out, stderr: err, preopens: [['/', '/']] });
  const wasi = new WasiProcess(vfs, pid, argv, []);
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(vfs.readFile(path) as Uint8Array<ArrayBuffer>), {
    wasi_snapshot_preview1: wasi.imports,
  });
  wasi.setMemory((inst.exports as { memory: WebAssembly.Memory }).memory);
  let code = 0;
  try {
    (inst.exports as { _start(): void })._start();
  } catch (e) {
    if (!(e instanceof ProcExit)) throw e;
    code = e.code;
  } finally {
    freeProcess(vfs, pid);
  }
  const res = { code, stdout: vfs.readText(out), stderr: vfs.readText(err), ms: Math.round(performance.now() - t0) };
  vfs.unlink(out);
  vfs.unlink(err);
  return res;
}
