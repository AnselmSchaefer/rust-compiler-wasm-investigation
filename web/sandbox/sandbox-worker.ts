// Worker entry of the run sandbox (WP-13): one wasm32-wasip1 program per worker, on a VFS of its
// own that holds only the files the host passed in, so it never sees the project or the toolchain.
// No network: the program's only imports are WASI preview 1, whose socket calls return NOSYS. The
// host kills it by terminating this worker.
import { createVfs, Kind, Vfs } from '../vfs/vfs';
import { createProcess, ProcExit, WasiProcess } from '../wasi/wasi';
import { PipeReader } from './pipe';
import type { SandboxEvent, SandboxStart } from './sandbox';

const post = (e: SandboxEvent, transfer: Transferable[] = []) => postMessage(e, { transfer });

// A failure outside the program (setup, a bad module) must still end the run: an exception in an
// async handler would otherwise only be an unhandled rejection, and the host would wait forever.
onmessage = (e: MessageEvent<SandboxStart>) => {
  run(e.data).catch(err => post({ type: 'exit', code: 134, trap: `sandbox: ${String((err as Error)?.stack ?? err)}`, files: [] }));
};

async function run({ vfsUrl, module, args, env, stdin, files, dirs, collect }: SandboxStart) {
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
  try {
    const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.imports });
    const x = inst.exports as { memory?: WebAssembly.Memory; _start?: () => void };
    if (!x.memory || !x._start) throw new Error('not a wasm32-wasip1 command (needs an exported memory and _start)');
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
