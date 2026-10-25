// rustc.wasm + wasm-ld.wasm under wasmtime-threads, linking outside rustc (WP-06).
//
//   node toolchain/rustc-wasm.ts hello.rs --target wasm32-wasip1 -o hello.wasm
//
// The current directory is the guest's `/` (and its working directory), so paths must be relative
// to it. rustup's 1.99.1 rustlib is the sysroot (at /sysroot). Outputs are written to a private scratch dir and
// moved into place afterwards, so rustc's temp dirs and objects never reach the real output dir,
// even when rustc aborts at the link step. Limits: one linked crate type per call; `-o` and
// `--out-dir` are rewritten, `--emit kind=path` is not.
//
// Env: RUSTC_WASM, WASM_LD_WASM (module paths), RUSTLIB (sysroot's lib/rustlib, default rustup
// 1.99.1's), WASMTIME (default wasmtime-threads). RUSTC_BOOTSTRAP is passed on to rustc (with
// RUSTC_ICE=0: in nightly mode rustc would write an ICE file and hang on process::id()).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, copyFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { linkerSpawnError, outputDestination, parseLinkCommand, rewriteOutputs, wasmLdArgs } from '../web/link/link-args.ts';

const ROOT = resolve(import.meta.dirname, '..');
const RUSTC = process.env.RUSTC_WASM ?? join(ROOT, 'build/rustc-wasm/build/wasm32-wasip1-threads/stage1/bin/rustc.wasm');
const WASM_LD = process.env.WASM_LD_WASM ?? join(ROOT, 'build/llvm-wasm-install/bin/wasm-ld.wasm');
const WASMTIME = process.env.WASMTIME ?? 'wasmtime-threads';
const RUST_TAG = readFileSync(join(ROOT, 'toolchain/versions.env'), 'utf8').match(/^RUST_TAG=(.+)$/m)![1];
const RUSTLIB = process.env.RUSTLIB ?? join(execFileSync('rustc', [`+${RUST_TAG}`, '--print', 'sysroot'], { encoding: 'utf8' }).trim(), 'lib/rustlib');

const scratch = mkdtempSync(join(tmpdir(), 'rustc-wasm-'));
const OUT = '/tmp/out'; // guest path of scratch/out
mkdirSync(join(scratch, 'out'));
// rustc always derives a default sysroot (even with --sysroot) and trusts argv[0] only if it is a
// symlink; it then looks for lib/rustlib relative to the *working directory* (/), hence the second
// rustlib mount (see scripts/verify/wp-05.sh).
mkdirSync(join(scratch, 'sysroot/bin'), { recursive: true });
symlinkSync('../lib/rustc-is-a-wasm-module', join(scratch, 'sysroot/bin/rustc'));

// Outputs go to the scratch dir and are moved into place afterwards (web/link/link-args.ts).
const plan = rewriteOutputs(process.argv.slice(2), OUT, '/tmp/link-args');

const mounts = ['--dir', '.::/', '--dir', `${scratch}::/tmp`, '--dir', `${scratch}/sysroot::/sysroot`,
  '--dir', `${RUSTLIB}::/sysroot/lib/rustlib`, '--dir', `${RUSTLIB}::/lib/rustlib`];
const wasmtime = (argv0: string, module: string, argv: string[], stderr: 'pipe' | 'inherit') =>
  spawnSync(WASMTIME, ['run', '-W', 'threads=y,shared-memory=y,exceptions=y', '-S', 'threads=y', '--env', 'TMPDIR=/tmp',
    ...(process.env.RUSTC_BOOTSTRAP ? ['--env', `RUSTC_BOOTSTRAP=${process.env.RUSTC_BOOTSTRAP}`, '--env', 'RUSTC_ICE=0'] : []),
    ...mounts, '--argv0', argv0, module, ...argv], { stdio: ['inherit', 'inherit', stderr], encoding: 'utf8' });
// wasmtime 46 warns about -Sthreads on every run, and blanks a line of its own. rustc.wasm is built with panic=abort, so every
// fatal error ends in abort() and a wasm trap; its backtrace says nothing to the user (WP-07).
const quiet = (s: string) => s.split('\n').filter((l) => !l.startsWith('WARNING: the `-Sthreads`') && !/^ +$/.test(l)).join('\n')
  .replace(/^Error: (?:failed to run main module|error while executing at wasm backtrace)[\s\S]*?wasm trap: wasm `unreachable` instruction executed\n?/m,
    (t) => (/^\s+0: [^\n]*!abort$/m.test(t) ? '' : t));

let status = 1;
try {
  const r = wasmtime('/sysroot/bin/rustc', RUSTC, plan.args, 'pipe');
  let err = quiet(r.stderr);
  const linkFile = join(scratch, 'link-args');
  status = r.status ?? 1;
  if (status !== 0 && existsSync(linkFile)) {
    // rustc got to the link step and could not spawn the linker (WASI has no processes). Drop that
    // error (and, with panic=abort, the trap it causes); earlier diagnostics stay.
    const at = linkerSpawnError(err);
    if (at < 0) { process.stderr.write(err); throw new Error('rustc failed at the link step for another reason'); }
    process.stderr.write(err.slice(0, at));
    const cmd = parseLinkCommand(readFileSync(linkFile, 'utf8'));
    const ld = wasmtime('wasm-ld', WASM_LD, wasmLdArgs(cmd), 'pipe');
    process.stderr.write(quiet(ld.stderr));
    status = ld.status ?? 1;
  } else {
    process.stderr.write(err);
  }
  if (status === 0) {
    // Move the results into place; rustc's own leftovers (temp dirs, objects) stay behind.
    for (const f of readdirSync(join(scratch, 'out'))) {
      const src = join(scratch, 'out', f);
      const dst = outputDestination(plan, f);
      if (!statSync(src).isFile() || !dst) continue;
      mkdirSync(dirname(dst), { recursive: true });
      try { renameSync(src, dst); } catch { copyFileSync(src, dst); }
    }
  }
} catch (e) {
  process.stderr.write(`rustc-wasm: ${(e as Error).message}\n`);
  status = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
