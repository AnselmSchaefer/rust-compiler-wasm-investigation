// Record the resolver's golden lockfiles (WP-15):
//   node tests/resolver/make-golden.mjs [record|replay]      default: record
// For each crate in corpus.txt: the newest non-yanked stable version in the index snapshot,
// its published .crate unpacked into build/wp-15/corpus/, and `cargo generate-lockfile` from native
// cargo 1.99.1 with crates.io replaced by the index proxy (index-proxy.mjs) over the snapshot in
// build/wp-15/index/. Writes golden/<name>.lock and golden/versions.txt. "record" fills the
// snapshot from index.crates.io; "replay" works offline from it (and must give the same files).
// The recorded snapshot is committed as tests/resolver/index-snapshot.tar.zst (re-pack it after a record).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2] ?? 'record';
const ROOT = new URL('../..', import.meta.url).pathname;
const SNAP = join(ROOT, 'build/wp-15/index'), WORK = join(ROOT, 'build/wp-15/corpus');
const HOME = join(ROOT, 'build/wp-15/cargo-home'), GOLDEN = join(ROOT, 'tests/resolver/golden');
const PORT = 8799, TAG = readFileSync(join(ROOT, 'toolchain/versions.env'), 'utf8').match(/^RUST_TAG=(.+)$/m)[1];
const names = readFileSync(join(ROOT, 'tests/resolver/corpus.txt'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

// Replay from the committed snapshot (tests/resolver/index-snapshot.tar.zst) if it isn't unpacked.
if (mode === 'replay' && !existsSync(SNAP)) {
  mkdirSync(join(SNAP, '..'), { recursive: true });
  execFileSync('sh', ['-c', `zstd -dc '${join(ROOT, 'tests/resolver/index-snapshot.tar.zst')}' | tar -x -C '${join(SNAP, '..')}'`]);
}
mkdirSync(SNAP, { recursive: true });
mkdirSync(GOLDEN, { recursive: true });
mkdirSync(HOME, { recursive: true });
writeFileSync(join(HOME, 'config.toml'), `[source.crates-io]\nreplace-with = "snapshot"\n[source.snapshot]\nregistry = "sparse+http://localhost:${PORT}/"\n`);

const proxy = spawn('node', [join(ROOT, 'tests/resolver/index-proxy.mjs'), mode, SNAP, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => proxy.stdout.once('data', r));

// The sparse index path of a crate name (https://doc.rust-lang.org/cargo/reference/registry-index.html#index-files).
const indexPath = n => { n = n.toLowerCase(); return n.length <= 2 ? `${n.length}/${n}` : n.length === 3 ? `3/${n[0]}/${n}` : `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`; };
const cmp = (a, b) => { const p = v => v.split(/[.+-]/).slice(0, 3).map(Number); const [x, y] = [p(a), p(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

const versions = [], failed = [];
try {
  for (const name of names) {
    const lines = (await (await fetch(`http://localhost:${PORT}/${indexPath(name)}`)).text()).trim().split('\n').map(l => JSON.parse(l));
    const v = lines.filter(l => !l.yanked && !l.vers.includes('-')).map(l => l.vers).sort(cmp).at(-1);
    const dir = join(WORK, `${name}-${v}`);
    if (!existsSync(join(dir, 'Cargo.toml'))) {
      mkdirSync(WORK, { recursive: true });
      const crate = join(WORK, `${name}-${v}.crate`);
      if (!existsSync(crate)) {
        const r = await fetch(`https://static.crates.io/crates/${name}/${name}-${v}.crate`);
        if (!r.ok) throw new Error(`${name} ${v}: download ${r.status}`);
        writeFileSync(crate, Buffer.from(await r.arrayBuffer()));
      }
      execFileSync('tar', ['-xzf', crate, '-C', WORK]);
    }
    rmSync(join(dir, 'Cargo.lock'), { force: true }); // binaries publish theirs; we want a fresh resolve
    try {
      execFileSync('cargo', [`+${TAG}`, 'generate-lockfile', '--manifest-path', join(dir, 'Cargo.toml')],
        { env: { ...process.env, CARGO_HOME: HOME, CARGO_NET_OFFLINE: 'false' }, stdio: ['ignore', 'ignore', 'pipe'] });
      copyFileSync(join(dir, 'Cargo.lock'), join(GOLDEN, `${name}.lock`));
      const pkgs = (readFileSync(join(dir, 'Cargo.lock'), 'utf8').match(/^\[\[package\]\]/gm) ?? []).length;
      versions.push(`${name} ${v} ${pkgs}`);
      console.log(`  ${name} ${v}: ${pkgs} packages`);
    } catch (e) {
      failed.push(`${name} ${v}: ${String(e.stderr ?? e).trim().split('\n').slice(-3).join(' | ')}`);
      console.log(`  ${name} ${v}: FAILED`);
    }
  }
} finally {
  proxy.kill();
}
writeFileSync(join(GOLDEN, 'versions.txt'), `# name version packages-in-lockfile (native cargo ${TAG}, ${mode} ${new Date().toISOString().slice(0, 10)})\n${versions.join('\n')}\n`);
if (failed.length) { console.log(`failed (${failed.length}):\n  ${failed.join('\n  ')}`); process.exitCode = 1; }
