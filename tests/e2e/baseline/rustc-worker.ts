// Runs rustc.wasm as a WASI command. Its threads are spawned as workers running thread-spawn.ts.
import { WASIFarmAnimal } from '@oligami/browser_wasi_shim-threads';

onmessage = async (e: MessageEvent) => {
  const { ref, wasmUrl, args } = e.data;
  const ms: Record<string, number> = {};
  try {
    let t = performance.now();
    const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl));
    ms.rustcCompileModule = Math.round(performance.now() - t);

    const wasi = new WASIFarmAnimal(ref, ['rustc', ...args], ['RUST_MIN_STACK=16777216'], {
      can_thread_spawn: true,
      thread_spawn_worker_url: new URL('thread-spawn.js', import.meta.url).href,
      thread_spawn_wasm: wasm,
      // rustc imports `env.memory` with min 399 / max 16384 pages; the shim's default (256 pages) is too small.
      share_memory: { memory: new WebAssembly.Memory({ initial: 400, maximum: 16384, shared: true }) },
    });
    await wasi.wait_worker_background_worker();

    t = performance.now();
    const code = wasi.block_start_on_thread();
    ms.rustcRun = Math.round(performance.now() - t);
    postMessage({ code, ms });
  } catch (err: any) {
    postMessage({ error: String(err?.stack ?? err), ms });
  }
};
