// The orchestrator (WP-12): one VFS, the toolchain release, a long-lived compile server
// (rustc --server --follow, toolchain/rustc-multi) and a linker process (wasm-ld.wasm) per link.
// Jobs run one at a time, in order. rustc stops at the link step with its link command printed
// (web/link/link-args.ts); the orchestrator runs wasm-ld with it on the same VFS, then moves the
// results out of the job's scratch dir. Runs in a page or a worker (orchestrator-worker.ts).

import { createVfs, Kind, Vfs, type VfsHandle } from '../vfs/vfs';
import { runProcess, type RunResult } from '../wasi/process';
import { linkerSpawnError, outputDestination, parseLinkCommand, rewriteOutputs, wasmLdArgs } from '../link/link-args';
import { Release, type Tool } from './toolchain';
import { readTar } from './tar';

export interface RustcResult {
  /** 0 ok, 1 errors, 101 ICE; for builds that link, the linker's exit code. */
  code: number;
  /** rustc's (and the linker's) diagnostics. */
  stderr: string;
  /** Whether the job ran wasm-ld. */
  linked: boolean;
  /** Files written, after moving them out of the scratch dir. */
  outputs: string[];
  ms: { rustc: number; link: number; total: number };
}

const RUSTC_ARGV0 = '/sysroot/bin/rustc';
// rustc's main thread needs more than the default stack for deep expressions (as in WP-01).
const ENV = ['RUST_MIN_STACK=16777216'];

export class Orchestrator {
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = 0;
  private linkGroup: Promise<void> | null = null;

  private constructor(
    readonly vfs: Vfs, private readonly handle: VfsHandle, readonly release: Release,
    private readonly rustc: Tool, private readonly workerUrl: URL, private readonly server: CompileServer,
  ) {}

  /**
   * `releaseUrl`: a release directory (…/<RUSTC_ID>/). `workerUrl`: web/wasi/process-worker.js.
   * `vfsUrl`: vfs.wasm. Loads rustc and the sysroot's metadata group; the link group and lld come
   * with the first link.
   */
  static async create(opts: { releaseUrl: string | URL; workerUrl: string | URL; vfsUrl: string | URL }): Promise<Orchestrator> {
    const handle = await createVfs(String(opts.vfsUrl));
    const vfs = await Vfs.attach(handle);
    const release = await Release.open(String(opts.releaseUrl));
    const [rustc] = await Promise.all([release.tool('rustc'), unpack(vfs, release, 'meta')]);
    // rustc trusts argv[0] for its sysroot only if it is a symlink, then checks lib/rustlib relative
    // to the working directory (/), hence the second link (scripts/verify/wp-05.sh).
    vfs.mkdirAll('/sysroot/bin');
    vfs.symlink('../lib/rustc-is-a-wasm-module', RUSTC_ARGV0);
    vfs.mkdirAll('/lib');
    vfs.symlink('/sysroot/lib/rustlib', '/lib/rustlib');
    vfs.mkdirAll('/tmp');
    vfs.mkdirAll('/proc');
    const workerUrl = new URL(String(opts.workerUrl));
    const server = new CompileServer(vfs, handle, rustc, workerUrl);
    return new Orchestrator(vfs, handle, release, rustc, workerUrl, server);
  }

  /** Run rustc with `args` (paths in the VFS; the working directory is /), linking if needed. */
  rustcJob(args: string[]): Promise<RustcResult> {
    const job = this.queue.then(() => this.run(args));
    this.queue = job.catch(() => {});
    return job;
  }

  private async run(user: string[]): Promise<RustcResult> {
    const t0 = performance.now();
    const scratch = `/tmp/job-${++this.jobs}`, linkFile = `${scratch}/link-args`;
    this.vfs.mkdirAll(scratch);
    try {
      const plan = rewriteOutputs(user, scratch, linkFile);
      // A build that links needs the .rlib files while rustc runs (it checks dependency formats
      // before linking); --emit=metadata or obj alone needs only the .rmeta files.
      if (emitsLink(user)) await this.loadLinkGroup();
      const r = await this.server.request(plan.args);
      let code = r.exit, stderr = r.stderr, linked = false, linkMs = 0;
      if (code !== 0 && this.vfs.exists(linkFile)) {
        // rustc got to the link step and couldn't start a linker: link here instead.
        const at = linkerSpawnError(stderr);
        if (at >= 0) {
          stderr = stderr.slice(0, at);
          const t1 = performance.now();
          const ld = await this.link(wasmLdArgs(parseLinkCommand(this.vfs.readText(linkFile))));
          linkMs = performance.now() - t1;
          code = ld.code;
          stderr += ld.stderr;
          linked = true;
        }
      }
      const outputs: string[] = [];
      if (code === 0) {
        for (const e of this.vfs.readdir(scratch)) {
          // rustc's temp dirs and its link command stay behind and go with the scratch dir.
          const dst = outputDestination(plan, e.name);
          if (!dst || e.kind !== Kind.File || e.name === 'link-args') continue;
          const to = dst.startsWith('./') ? dst.slice(1) : dst.startsWith('/') ? dst : `/${dst}`;
          this.vfs.mkdirAll(to.slice(0, to.lastIndexOf('/')) || '/');
          this.vfs.rename(`${scratch}/${e.name}`, to);
          outputs.push(to);
        }
      }
      return { code, stderr, linked, outputs, ms: { rustc: r.ms, link: Math.round(linkMs), total: Math.round(performance.now() - t0) } };
    } finally {
      this.vfs.removeAll(scratch);
    }
  }

  /** Run wasm-ld.wasm with `args` as a process of its own. */
  private loadLinkGroup() {
    this.linkGroup ??= unpack(this.vfs, this.release, 'link');
    return this.linkGroup;
  }

  private async link(args: string[]): Promise<{ code: number; stderr: string }> {
    const [lld] = await Promise.all([this.release.tool('lld'), this.loadLinkGroup()]);
    const n = ++this.jobs, out = `/proc/ld-${n}.out`, err = `/proc/ld-${n}.err`;
    const memory = new WebAssembly.Memory({ ...lld.limits, shared: true });
    const r = await runProcess(this.vfs, this.handle, lld.module, memory,
      { args: ['wasm-ld', ...args], env: [], stdout: out, stderr: err, preopens: [['/', '/']] }, this.workerUrl);
    const res = { code: r.code, stderr: this.vfs.readText(out) + this.vfs.readText(err) + (r.error ? `\n${r.error}\n` : '') };
    this.vfs.unlink(out);
    this.vfs.unlink(err);
    return res;
  }

  stats() {
    return { vfsBytes: this.handle.memory.buffer.byteLength, rustcBytes: this.server.memoryBytes, jobs: this.jobs };
  }

  /** Stop the compile server; resolves with its process result. */
  async close(): Promise<RunResult> { await this.queue; return this.server.quit(); }
}

/** Whether rustc with `args` emits `link` (the default when there is no --emit). */
export function emitsLink(args: string[]): boolean {
  const kinds: string[] = [];
  args.forEach((a, i) => {
    const v = a === '--emit' ? args[i + 1] : a.startsWith('--emit=') ? a.slice(7) : null;
    if (v) kinds.push(...v.split(',').map(k => k.split('=')[0]));
  });
  return kinds.length === 0 || kinds.includes('link');
}

/** Extract one sysroot group of the release into /sysroot. */
async function unpack(vfs: Vfs, release: Release, group: 'meta' | 'link') {
  const tar = await release.bytes(release.manifest.sysroot[group]);
  for (const e of readTar(tar)) vfs.writeFile(`/sysroot/${e.path}`, e.data);
}

/**
 * rustc-multi --server --follow in one long-lived instance. Requests are appended to its stdin
 * file as JSON lines; each answer is a JSON line on stdout, and "\x1e<id>" on stderr ends that
 * request's diagnostics. The process runner wakes us on every stdout write.
 */
class CompileServer {
  private nextId = 0;
  private outPos = 0;
  private errPos = 0;
  private wake: (() => void) | undefined;
  private readonly stdin: string;
  private readonly stdout: string;
  private readonly stderr: string;
  private readonly done: Promise<RunResult>;
  private readonly memory: WebAssembly.Memory;

  get memoryBytes() { return this.memory.buffer.byteLength; }

  constructor(private readonly vfs: Vfs, handle: VfsHandle, rustc: Tool, workerUrl: URL) {
    this.stdin = '/proc/rustc.in';
    this.stdout = '/proc/rustc.out';
    this.stderr = '/proc/rustc.err';
    vfs.writeFile(this.stdin, '');
    const memory = new WebAssembly.Memory({ ...rustc.limits, shared: true });
    this.memory = memory;
    this.done = runProcess(vfs, handle, rustc.module, memory, {
      args: [RUSTC_ARGV0, '--server', '--follow'], env: ENV,
      stdin: this.stdin, stdout: this.stdout, stderr: this.stderr, preopens: [['/', '/']],
    }, workerUrl, () => this.wake?.());
  }

  async request(args: string[]): Promise<{ exit: number; ms: number; stderr: string }> {
    const id = ++this.nextId;
    this.vfs.appendFile(this.stdin, JSON.stringify({ id, args }) + '\n');
    const answer = await this.answer(id);
    const e = this.vfs.readText(this.stderr), mark = `\x1e${id}\n`, at = e.indexOf(mark, this.errPos);
    const stderr = e.slice(this.errPos, at);
    this.errPos = at + mark.length;
    return { exit: answer.exit, ms: answer.ms, stderr };
  }

  private async answer(id: number): Promise<{ exit: number; ms: number }> {
    for (;;) {
      const text = this.vfs.readText(this.stdout);
      const nl = text.indexOf('\n', this.outPos);
      if (nl >= 0) {
        const line = text.slice(this.outPos, nl);
        this.outPos = nl + 1; // other lines are rustc's own stdout (e.g. -V)
        if (line.startsWith('{') && JSON.parse(line).id === id) return JSON.parse(line);
        continue;
      }
      // Woken by the server's next stdout write; the timeout only guards against a lost wake-up.
      await new Promise<void>(r => { this.wake = r; setTimeout(r, 50); });
    }
  }

  async quit() {
    this.vfs.appendFile(this.stdin, JSON.stringify({ id: ++this.nextId, quit: true }) + '\n');
    return this.done;
  }
}
