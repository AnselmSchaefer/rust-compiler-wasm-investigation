// A build script's `Command` (WP-21): the build-script std (bs-std/lib.rs) sends each child it
// runs to the host as one request, and blocks until the answer. The only program there is rustc:
// `$RUSTC` or `rustc`, which runs as a job on a compile server with the script's working
// directory, environment and stdin. Anything else is "not found", which build scripts treat like
// a missing tool. The wire format is bs-std's.

export interface SpawnRequest { program: string; cwd: string; stdin: Uint8Array; args: string[]; env: Record<string, string> }
/** status -1: the program wasn't found (stderr says why). */
export interface SpawnResult { status: number; stdout: Uint8Array; stderr: Uint8Array }

const dec = new TextDecoder(), enc = new TextEncoder();

export function decodeSpawn(b: Uint8Array): SpawnRequest {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  const word = () => { const w = dv.getUint32(at, true); at += 4; return w; };
  const bytes = () => { const n = word(), r = b.subarray(at, at + n); at += n; return r; };
  const text = () => dec.decode(bytes());
  const program = text(), cwd = text(), stdin = bytes().slice();
  const args = Array.from({ length: word() }, text);
  const env: Record<string, string> = {};
  for (let n = word(); n > 0; n--) {
    const kv = text(), eq = kv.indexOf('=');
    env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return { program, cwd, stdin, args, env };
}

export function encodeSpawnResult(r: SpawnResult): Uint8Array {
  const o = new Uint8Array(12 + r.stdout.length + r.stderr.length), dv = new DataView(o.buffer);
  dv.setInt32(0, r.status, true);
  dv.setUint32(4, r.stdout.length, true);
  o.set(r.stdout, 8);
  dv.setUint32(8 + r.stdout.length, r.stderr.length, true);
  o.set(r.stderr, 12 + r.stdout.length);
  return o;
}

export type SpawnRustc = (args: string[], env: Record<string, string>, io: { cwd: string; stdin?: string }) =>
  Promise<{ code: number; stdout: string; stderr: string }>;

/** Whether a build script's program is the rustc it was given (RUSTC) or plain `rustc`. */
export function isRustc(program: string, env: Record<string, string>) {
  return program === env.RUSTC || program === 'rustc' || program === '/sysroot/bin/rustc';
}

export async function runSpawn(req: SpawnRequest, rustc: SpawnRustc): Promise<SpawnResult> {
  if (!isRustc(req.program, req.env)) {
    return { status: -1, stdout: new Uint8Array(), stderr: enc.encode(`${req.program}: not found (a build script in the sandbox can only run rustc)`) };
  }
  // rustc reads `-` as UTF-8 text, so the stdin bytes go over as a string.
  const stdin = req.args.includes('-') ? dec.decode(req.stdin) : undefined;
  const r = await rustc(req.args, req.env, { cwd: req.cwd, stdin });
  return { status: r.code, stdout: enc.encode(r.stdout), stderr: enc.encode(r.stderr) };
}
