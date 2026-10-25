// Run sandbox, host side (WP-13): run a compiled wasm32-wasip1 program in a worker of its own
// (sandbox-worker.ts) with args, env, stdin (given up front, typed later, or both), files in and
// out, live stdout/stderr, exit codes and traps, and a kill switch / timeout that terminates the
// worker. WP-21: host calls, for build scripts' `Command` (web/build/spawn.ts): a program that
// imports `rust_bs.run/take` blocks in `run` while the host answers through a growable
// SharedArrayBuffer; the files below the `sync` dirs go to the host with each call and come back.

import { createPipe, PipeWriter } from './pipe';

/** Message to sandbox-worker.ts. */
export interface SandboxStart {
  vfsUrl: string; module: WebAssembly.Module; args: string[]; env: string[]; stdin: SharedArrayBuffer;
  files: [string, Uint8Array][]; dirs: string[]; collect: string[];
  /** Host calls: the answer channel (see `answer`), and the dirs that go along. */
  calls: { channel: SharedArrayBuffer; sync: string[] } | null;
}
/** Messages from sandbox-worker.ts. */
export type SandboxEvent =
  | { type: 'output'; fd: 1 | 2; data: Uint8Array }
  | { type: 'call'; req: Uint8Array; files: [string, Uint8Array][] }
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
  /** Directories to create (empty) before it starts. */
  dirs?: string[];
  /** Files to read back when it exits; a path ending in '/' means every file below it. */
  collect?: string[];
  /** Answers the program's `rust_bs.run` calls. */
  hostCalls?: HostCalls;
  /** Kill the program after this long; default: no limit. */
  timeoutMs?: number;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
}

export interface HostCalls {
  /** `files`: those below `sync` now; the answer's files are written back (new or changed ones). */
  call(req: Uint8Array, files: Record<string, Uint8Array>): Promise<{ resp: Uint8Array; files: Record<string, Uint8Array> }>;
  sync: string[];
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

  const channel = o.hostCalls ? newChannel() : null;
  worker.onmessage = (e: MessageEvent<SandboxEvent>) => {
    const m = e.data;
    if (m.type === 'call') {
      o.hostCalls!.call(m.req, Object.fromEntries(m.files))
        .then(r => answer(channel!, packCall(r.resp, Object.entries(r.files))))
        .catch(err => end({ trap: `host call: ${String((err as Error)?.stack ?? err)}`, code: 134 }));
    } else if (m.type === 'output') {
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
      vfsUrl: String(o.vfsUrl), module, args: o.args ?? ['main'], env: o.env ?? [], stdin: pipe, files, dirs: o.dirs ?? [], collect: o.collect ?? [],
      calls: channel && { channel, sync: o.hostCalls!.sync },
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

// The host-call channel: i32 state (0 waiting, 1 answered), u32 length, then the answer. It grows
// to fit; the worker's views track its length.
const MAX_ANSWER = 1 << 30;

function newChannel(): SharedArrayBuffer {
  return new (SharedArrayBuffer as unknown as new (n: number, o: { maxByteLength: number }) => SharedArrayBuffer)(1 << 16, { maxByteLength: MAX_ANSWER });
}

function answer(channel: SharedArrayBuffer, data: Uint8Array) {
  const c = channel as SharedArrayBuffer & { grow(n: number): void };
  if (8 + data.length > c.byteLength) c.grow(8 + data.length);
  new Uint8Array(c, 8, data.length).set(data);
  const st = new Int32Array(c, 0, 2);
  Atomics.store(st, 1, data.length);
  Atomics.store(st, 0, 1);
  Atomics.notify(st, 0);
}

/** An answer: u32 length + response, u32 count, then per file u32 + path, u32 + data. */
export function packCall(resp: Uint8Array, files: [string, Uint8Array][]): Uint8Array {
  const paths = files.map(([p]) => enc.encode(p));
  const size = 8 + resp.length + files.reduce((a, [, d], i) => a + 8 + paths[i].length + d.length, 0);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  let at = 0;
  const put = (b: Uint8Array) => { dv.setUint32(at, b.length, true); out.set(b, at + 4); at += 4 + b.length; };
  put(resp);
  dv.setUint32(at, files.length, true);
  at += 4;
  files.forEach(([, d], i) => { put(paths[i]); put(d); });
  return out;
}

export function unpackCall(b: Uint8Array): { resp: Uint8Array; files: [string, Uint8Array][] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  const get = () => { const n = dv.getUint32(at, true), r = b.subarray(at + 4, at + 4 + n); at += 4 + n; return r; };
  const resp = get();
  const n = dv.getUint32(at, true);
  at += 4;
  const files: [string, Uint8Array][] = [];
  for (let i = 0; i < n; i++) files.push([new TextDecoder().decode(get()), get()]);
  return { resp, files };
}
