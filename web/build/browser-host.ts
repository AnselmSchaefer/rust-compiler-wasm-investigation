// cargoBuild's host in the browser: compiles go to the orchestrator's compile servers, build
// scripts run in the run sandbox with a copy of their package's files and an empty OUT_DIR.
// A script's rustc probes (WP-21) run on a compile server too, which sees the orchestrator's VFS:
// the sandbox's OUT_DIR is copied there before each probe, and what the probe wrote comes back.

import type { Orchestrator } from '../orchestrator/orchestrator';
import { runSandboxed } from '../sandbox/sandbox';
import { type BuildHost, filesBelow } from './cargo';

export function browserHost(orch: Orchestrator, sandbox: { workerUrl: string; vfsUrl: string }): BuildHost {
  const vfs = orch.vfs;
  return {
    vfs, rustcId: orch.release.id, workers: orch.workers,
    rustc: (args, env, io) => orch.rustcJob(args, env, io),
    async runScript(o) {
      const files: Record<string, Uint8Array> = {};
      for (const p of filesBelow(vfs, o.pkgDir)) files[p] = vfs.readFile(p);
      const r = await runSandboxed({
        ...sandbox, program: vfs.readFile(o.program), args: o.args, env: o.env, files, dirs: [o.outDir], collect: [`${o.outDir}/`],
        hostCalls: {
          sync: [o.outDir],
          async call(req, now) {
            if (vfs.exists(o.outDir)) vfs.removeAll(o.outDir);
            vfs.mkdirAll(o.outDir);
            for (const [p, d] of Object.entries(now)) {
              vfs.mkdirAll(p.slice(0, p.lastIndexOf('/')));
              vfs.writeFile(p, d);
            }
            const resp = await o.call(req);
            const back: Record<string, Uint8Array> = {};
            for (const p of filesBelow(vfs, o.outDir)) {
              const d = vfs.readFile(p);
              if (!same(now[p], d)) back[p] = d;
            }
            return { resp, files: back };
          },
        },
      }).result;
      return { code: r.code, trap: r.trap, stdout: r.stdout, stderr: r.stderr, files: r.files };
    },
  };
}

function same(a: Uint8Array | undefined, b: Uint8Array) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
