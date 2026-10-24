// WP-12/13 e2e page: the orchestrator worker with a toolchain release, driven through `window.orch`,
// and the run sandbox (`window.sandbox`), as a terminal would use it.
import { OrchestratorClient } from '../../../web/orchestrator/client';
import { runSandboxed, type SandboxOptions } from '../../../web/sandbox/sandbox';

const here = (f: string) => new URL(f, location.href).href;
(window as any).orch = new OrchestratorClient(here('orchestrator-worker.js'));
(window as any).sandbox = (o: Omit<SandboxOptions, 'workerUrl' | 'vfsUrl'>) =>
  runSandboxed({ ...o, workerUrl: here('sandbox-worker.js'), vfsUrl: here('vfs.wasm') });
(window as any).orchReady = true;
