// WP-16 e2e page: resolve a manifest against the sparse index at /index/ (the pinned snapshot),
// download its crates from static.crates.io and unpack them into the VFS.
// `window.depsTest.run(manifest, clear)` → stats; everything is loaded before `depsReady`, so
// the test can go offline and run again from the OPFS cache.
import { createVfs, Kind, Vfs } from '../../../web/vfs/vfs';
import { FileCache } from '../../../web/deps/cache';
import { Resolver } from '../../../web/deps/resolver';
import { fetchDependencies } from '../../../web/deps/deps';

const handle = await createVfs('vfs.wasm');
const vfs = await Vfs.attach(handle);
const resolverModule = await WebAssembly.compileStreaming(fetch('resolver.wasm'));

function countFiles(path: string): number {
  let n = 0;
  for (const e of vfs.readdir(path)) n += e.kind === Kind.Dir ? countFiles(`${path}/${e.name}`) : 1;
  return n;
}

(window as any).depsTest = {
  async run(manifest: string, clear: boolean) {
    if (clear) await FileCache.clear();
    try { vfs.removeAll('/deps'); } catch { /* first run */ }
    const resolver = await Resolver.instantiate(resolverModule);
    const r = await fetchDependencies(manifest, vfs, { resolver, index: '/index/' });
    const serde = r.packages.find(p => p.name === 'serde')!;
    return {
      lock: r.lock, rounds: r.rounds, index: r.index, ms: r.ms,
      packages: r.packages.length,
      crates: r.crates.length, fromCache: r.crates.filter(c => c.fromCache).length,
      bytes: r.crates.reduce((a, c) => a + c.bytes, 0),
      filesUnpacked: r.crates.reduce((a, c) => a + c.files, 0),
      filesInVfs: countFiles('/deps'),
      serdeToml: new TextDecoder().decode(vfs.readFile(`/deps/serde-${serde.version}/Cargo.toml`)).slice(0, 2000),
      serdeFeatures: serde.features,
    };
  },
};
(window as any).depsReady = true;
