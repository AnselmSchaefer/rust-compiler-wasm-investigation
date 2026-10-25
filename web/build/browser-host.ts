// cargoBuild's host in the browser: compiles go to the orchestrator's compile servers, build
// scripts run in the run sandbox with a copy of their package's files and an empty OUT_DIR.

import type { Orchestrator } from '../orchestrator/orchestrator';
import { runSandboxed } from '../sandbox/sandbox';
import { type BuildHost, filesBelow } from './cargo';

export function browserHost(orch: Orchestrator, sandbox: { workerUrl: string; vfsUrl: string }): BuildHost {
  const vfs = orch.vfs;
  return {
    vfs, rustcId: orch.release.id, workers: orch.workers,
    rustc: (args, env) => orch.rustcJob(args, env),
    async runScript(o) {
      const files: Record<string, Uint8Array> = {};
      for (const p of filesBelow(vfs, o.pkgDir)) files[p] = vfs.readFile(p);
      const r = await runSandboxed({
        ...sandbox, program: vfs.readFile(o.program), args: o.args, env: o.env, files, dirs: [o.outDir], collect: [`${o.outDir}/`],
      }).result;
      return { code: r.code, trap: r.trap, stdout: r.stdout, stderr: r.stderr, files: r.files };
    },
  };
}
