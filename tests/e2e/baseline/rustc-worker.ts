// Runs rustc.wasm as a WASI command, one fresh instance per `run` message.
// Its threads are spawned as workers running thread-spawn.ts.
import { WASIFarmAnimal } from '@oligami/browser_wasi_shim-threads';

let ref: unknown;
let module: WebAssembly.Module;

onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    ({ ref, module } = msg);
    postMessage({});
    return;
  }
  const t = performance.now();
  try {
    // rustc imports `env.memory` with min 399 / max 16384 pages; the shim's default (256 pages) is too small.
    const memory = new WebAssembly.Memory({ initial: 400, maximum: 16384, shared: true });
    const wasi = new WASIFarmAnimal(ref as any, ['rustc', ...msg.args], ['RUST_MIN_STACK=16777216'], {
      can_thread_spawn: true,
      thread_spawn_worker_url: new URL('thread-spawn.js', import.meta.url).href,
      thread_spawn_wasm: module,
      share_memory: { memory },
    });
    await wasi.wait_worker_background_worker();
    const code = wasi.block_start_on_thread();
    const ms = Math.round(performance.now() - t);
    const memBytes = memory.buffer.byteLength;
    wasi.destroy(); // terminate this instance's thread workers
    postMessage({ code, ms, memBytes });
  } catch (err: any) {
    postMessage({ error: String(err?.stack ?? err), ms: Math.round(performance.now() - t) });
  }
};
