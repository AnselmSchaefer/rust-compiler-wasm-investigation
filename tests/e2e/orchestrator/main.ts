// WP-12 e2e page: the orchestrator worker with a toolchain release, driven through `window.orch`.
import { OrchestratorClient } from '../../../web/orchestrator/client';

(window as any).orch = new OrchestratorClient(new URL('orchestrator-worker.js', location.href));
(window as any).orchReady = true;
