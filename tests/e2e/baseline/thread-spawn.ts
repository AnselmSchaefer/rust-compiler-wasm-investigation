// Worker entry for every wasi-threads thread (and the rustc main thread under block_start_on_thread).
import { thread_spawn_on_worker } from '@oligami/browser_wasi_shim-threads';

onmessage = async (e: MessageEvent) => {
  await thread_spawn_on_worker(e.data);
};
