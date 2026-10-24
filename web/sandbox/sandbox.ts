// Run sandbox, host side (WP-13): run a compiled wasm32-wasip1 program in a worker of its own
// (sandbox-worker.ts) with args, env, stdin (given up front, typed later, or both), files in and
// out, live stdout/stderr, exit codes and traps, and a kill switch / timeout that terminates the
// worker.

import { createPipe, PipeWriter } from './pipe';

/** Message to sandbox-worker.ts. */
export interface SandboxStart {
  vfsUrl: string; module: WebAssembly.Module; args: string[]; env: string[]; stdin: SharedArrayBuffer;
  files: [string, Uint8Array][]; collect: string[];
}
/** Messages from sandbox-worker.ts. */
export type SandboxEvent =
  | { type: 'output'; fd: 1 | 2; data: Uint8Array }
  | { type: 'exit'; code: number; trap?: string; files: [string, Uint8Array][] };

export interface SandboxOptions {
  workerUrl: string | URL;
  vfsUrl: string | URL;
  /** The program: a compiled module or its bytes. */
  program: WebAssembly.Module | Uint8Array;
  /** argv[0] defaults to "main". */
  args?: string[];
  env?: string[];
  /** Written to stdin before the program starts. */
  stdin?: string | Uint8Array;
  /** Keep stdin open after `stdin` for writes through the handle (a terminal); default: close it. */
  interactive?: boolean;
  /** Files the program sees (absolute paths in its own filesystem). */
  files?: Record<string, string | Uint8Array>;
  /** Files to read back when it exits. */
  collect?: string[];
  /** Kill the program after this long; default: no limit. */
  timeoutMs?: number;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
}

export interface SandboxResult {
  /** Exit code (134 for a trap, e.g. a panic); null if it was killed. */
  code: number | null;
  killed: boolean;
  timedOut: boolean;
  trap?: string;
  stdout: string;
  stderr: string;
  files: Record<string, Uint8Array>;
  ms: number;
}

export interface SandboxHandle {
  /** Feed stdin (interactive runs). */
  write(data: string | Uint8Array): void;
  /** End of input. */
  closeStdin(): void;
  /** Stop the program now (terminates its worker). */
  kill(): void;
  result: Promise<SandboxResult>;
}

const enc = new TextEncoder();

export function runSandboxed(o: SandboxOptions): SandboxHandle {
  const t0 = performance.now();
  const pipe = createPipe(), stdin = new PipeWriter(pipe);
  const worker = new Worker(o.workerUrl, { type: 'module' });
  const out: Uint8Array[] = [], err: Uint8Array[] = [];
  let finish!: (r: SandboxResult) => void, timer: ReturnType<typeof setTimeout> | undefined, done = false;
  const result = new Promise<SandboxResult>(r => { finish = r; });
  const text = (parts: Uint8Array[]) => new TextDecoder().decode(concat(parts));
  const end = (r: Partial<SandboxResult>) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    worker.terminate();
    finish({ code: null, killed: false, timedOut: false, files: {}, ...r, stdout: text(out), stderr: text(err), ms: Math.round(performance.now() - t0) });
  };

  worker.onmessage = (e: MessageEvent<SandboxEvent>) => {
    const m = e.data;
    if (m.type === 'output') {
      (m.fd === 1 ? out : err).push(m.data);
      (m.fd === 1 ? o.onStdout : o.onStderr)?.(m.data);
    } else {
      end({ code: m.code, trap: m.trap, files: Object.fromEntries(m.files) });
    }
  };
  worker.onerror = e => end({ trap: `sandbox worker: ${e.message}`, code: 134 });

  (async () => {
    const module = o.program instanceof WebAssembly.Module ? o.program : await WebAssembly.compile(o.program as Uint8Array<ArrayBuffer>);
    const files = Object.entries(o.files ?? {}).map(([p, d]): [string, Uint8Array] => [p, typeof d === 'string' ? enc.encode(d) : d]);
    worker.postMessage({
      vfsUrl: String(o.vfsUrl), module, args: o.args ?? ['main'], env: o.env ?? [], stdin: pipe, files, collect: o.collect ?? [],
    } satisfies SandboxStart);
    if (o.stdin !== undefined) stdin.write(typeof o.stdin === 'string' ? enc.encode(o.stdin) : o.stdin);
    if (!o.interactive) stdin.close();
    if (o.timeoutMs !== undefined) timer = setTimeout(() => end({ killed: true, timedOut: true }), o.timeoutMs);
  })().catch(e => end({ trap: String(e), code: 134 }));

  return {
    write: d => stdin.write(typeof d === 'string' ? enc.encode(d) : d),
    closeStdin: () => stdin.close(),
    kill: () => end({ killed: true }),
    result,
  };
}

function concat(parts: Uint8Array[]) {
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}
