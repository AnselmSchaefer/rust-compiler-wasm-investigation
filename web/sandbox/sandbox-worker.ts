// Worker entry of the run sandbox (WP-13): one wasm32-wasip1 program per worker, on a VFS of its
// own that holds only the files the host passed in, so it never sees the project or the toolchain.
// No network: the program's only imports are WASI preview 1, whose socket calls return NOSYS. The
// host kills it by terminating this worker.
import { createVfs, Kind, Vfs } from '../vfs/vfs';
import { createProcess, ProcExit, WasiProcess } from '../wasi/wasi';
import { PipeReader } from './pipe';
import { type SandboxEvent, type SandboxStart, unpackCall } from './sandbox';

const post = (e: SandboxEvent, transfer: Transferable[] = []) => postMessage(e, { transfer });

// A failure outside the program (setup, a bad module) must still end the run: an exception in an
// async handler would otherwise only be an unhandled rejection, and the host would wait forever.
onmessage = (e: MessageEvent<SandboxStart>) => {
  run(e.data).catch(err => post({ type: 'exit', code: 134, trap: `sandbox: ${String((err as Error)?.stack ?? err)}`, files: [] }));
};

async function run({ vfsUrl, module, args, env, stdin, files, dirs, collect, calls }: SandboxStart) {
  const vfs = await Vfs.attach(await createVfs(vfsUrl));
  for (const [path, data] of files) vfs.writeFile(path, data);
  for (const d of dirs) vfs.mkdirAll(d);
  vfs.mkdirAll('/proc');
  const out = '/proc/stdout', err = '/proc/stderr';
  vfs.writeFile(out, '');
  vfs.writeFile(err, '');
  const pid = createProcess(vfs, { args, env, stdout: out, stderr: err, preopens: [['/', '/']] });

  // Stream each write as it happens.
  const streams = { 1: { ino: vfs.lookup(out), pos: 0 }, 2: { ino: vfs.lookup(err), pos: 0 } };
  const flush = (fd: 1 | 2) => {
    const s = streams[fd];
    const size = vfs.stat(fd === 1 ? out : err).size;
    if (size <= s.pos) return;
    const chunk = new Uint8Array(size - s.pos);
    vfs.locked(() => vfs.rawRead(s.ino, s.pos, chunk));
    s.pos = size;
    post({ type: 'output', fd, data: chunk }, [chunk.buffer]);
  };
  const reader = new PipeReader(stdin);
  const wasi = new WasiProcess(vfs, pid, args, env, fd => { if (fd === 1 || fd === 2) flush(fd); }, bufs => reader.read(bufs));

  let code = 0, trap: string | undefined;
  let memory: WebAssembly.Memory | undefined;
  try {
    const imports: WebAssembly.Imports = { wasi_snapshot_preview1: wasi.imports };
    if (WebAssembly.Module.imports(module).some(i => i.module === 'rust_bs')) {
      if (!calls) throw new Error('the program makes host calls (rust_bs), but this sandbox answers none');
      imports.rust_bs = hostCalls(vfs, calls, () => memory!);
    }
    const inst = await WebAssembly.instantiate(module, imports);
    const x = inst.exports as { memory?: WebAssembly.Memory; _start?: () => void };
    if (!x.memory || !x._start) throw new Error('not a wasm32-wasip1 command (needs an exported memory and _start)');
    memory = x.memory;
    wasi.setMemory(x.memory);
    x._start();
  } catch (err) {
    if (err instanceof ProcExit) code = err.code;
    else {
      // A Rust panic ends in abort(), i.e. `unreachable`: report it like a SIGABRT.
      code = 134;
      trap = err instanceof WebAssembly.RuntimeError ? `wasm trap: ${err.message}` : String((err as Error)?.stack ?? err);
    }
  }
  flush(1);
  flush(2);
  // A path ending in '/' collects every file below it (a build script's OUT_DIR).
  const paths = collect.flatMap(p => p.endsWith('/') ? (vfs.exists(p) ? filesBelow(vfs, p.slice(0, -1)) : []) : [p]);
  const back: [string, Uint8Array][] = paths.filter(p => vfs.exists(p)).map(p => [p, vfs.readFile(p)]);
  post({ type: 'exit', code, trap, files: back }, back.map(([, d]) => d.buffer as ArrayBuffer));
}

function filesBelow(vfs: Vfs, dir: string): string[] {
  return vfs.readdir(dir).flatMap(e => {
    const p = `${dir}/${e.name}`;
    return e.kind === Kind.Dir ? filesBelow(vfs, p) : e.kind === Kind.File ? [p] : [];
  });
}

/**
 * `rust_bs.run(req, len) -> answer length` posts the request with the `sync` dirs' files and waits
 * for the host's answer (sandbox.ts); the files that come back are written first. `take(buf)`
 * copies the answer into the program's memory.
 */
function hostCalls(vfs: Vfs, calls: NonNullable<SandboxStart['calls']>, memory: () => WebAssembly.Memory) {
  const st = new Int32Array(calls.channel, 0, 2);
  let last = new Uint8Array();
  return {
    run(ptr: number, len: number): number {
      const req = new Uint8Array(memory().buffer, ptr, len).slice();
      const files: [string, Uint8Array][] = calls.sync.flatMap(d => (vfs.exists(d) ? filesBelow(vfs, d) : [])).map(p => [p, vfs.readFile(p)]);
      Atomics.store(st, 0, 0);
      post({ type: 'call', req, files }, [req.buffer, ...files.map(([, d]) => d.buffer as ArrayBuffer)]);
      Atomics.wait(st, 0, 0);
      const n = Atomics.load(st, 1);
      const a = unpackCall(new Uint8Array(calls.channel, 8, n).slice());
      for (const [p, d] of a.files) {
        vfs.mkdirAll(p.slice(0, p.lastIndexOf('/')) || '/');
        vfs.writeFile(p, d);
      }
      last = a.resp.slice();
      return last.length;
    },
    take(ptr: number) {
      new Uint8Array(memory().buffer, ptr, last.length).set(last);
    },
  };
}
