// Worker entry: owns the orchestrator and answers the typed requests of protocol.ts.
import { Orchestrator } from './orchestrator';
import { runSandboxed } from '../sandbox/sandbox';
import type { Ops, Request, Response, RunOutput } from './protocol';

let orch: Orchestrator | undefined, vfsUrl: string | undefined, sandboxUrl: string | undefined;
const need = () => { if (!orch) throw new Error('orchestrator: init first'); return orch; };

const handlers: { [O in keyof Ops]: (a: Ops[O]['args']) => Promise<Ops[O]['result']> | Ops[O]['result'] } = {
  async init(a) {
    const t0 = performance.now();
    orch = await Orchestrator.create(a);
    vfsUrl = a.vfsUrl;
    sandboxUrl = a.sandboxWorkerUrl ?? new URL('sandbox-worker.js', self.location.href).href;
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

/** A wasm32-wasip1 program from the VFS, in the run sandbox (a worker of its own). */
async function runProgram(path: string, args: string[]): Promise<RunOutput> {
  const r = await runSandboxed({
    workerUrl: sandboxUrl!, vfsUrl: vfsUrl!, program: need().vfs.readFile(path), args: [path, ...args],
  }).result;
  return { code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr, ms: r.ms };
}
