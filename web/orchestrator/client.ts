// Page side of the orchestrator: starts orchestrator-worker.js and turns protocol.ts messages into
// typed async calls.
import type { Op, Ops, Request, Response } from './protocol';

export class OrchestratorClient {
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(workerUrl: string | URL) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<Response>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
    this.worker.onerror = e => {
      for (const p of this.pending.values()) p.reject(new Error(`orchestrator worker: ${e.message}`));
      this.pending.clear();
    };
  }

  call<O extends Op>(op: O, args: Ops[O]['args']): Promise<Ops[O]['result']> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, args } satisfies Request<O>);
    });
  }

  terminate() { this.worker.terminate(); }
}
