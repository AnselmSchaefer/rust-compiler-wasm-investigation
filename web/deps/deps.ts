// Dependencies for a project (WP-16): resolve Cargo.toml against the sparse index (fetching index
// files round by round, as the resolver asks for them), then download, verify and unpack every
// registry crate of the result into the VFS under `<dir>/<name>-<version>/`.

import { type ByteStore, FileCache } from './cache';
import { SparseIndex } from './index';
import { CRATES_IO_DL, type CrateStats, fetchCrate, unpackCrate } from './crates';
import { Resolver, type ResolvedPackage } from './resolver';
import type { Vfs } from '../vfs/vfs';

export interface DepsOptions {
  /** The resolver module (build/www/resolver/resolver.wasm), or an instance to reuse. */
  resolver: string | URL | Resolver;
  /** Sparse-index base URL, ending in '/'. */
  index: string;
  /** Crate download base (default static.crates.io). */
  dl?: string;
  /** Where crates are unpacked in the VFS. */
  dir?: string;
  /** Parallel requests (default 16); kept modest, per crates.io's crawler policy. */
  concurrency?: number;
  cache?: ByteStore;
}

export interface DepsResult {
  lock: string;
  packages: ResolvedPackage[];
  rounds: number;
  index: SparseIndex['stats'];
  crates: CrateStats[];
  ms: { resolve: number; download: number };
}

async function inParallel<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await f(items[next++]);
  }));
}

export async function resolveManifest(manifest: string, opts: DepsOptions): Promise<Omit<DepsResult, 'crates' | 'ms'> & { ms: number }> {
  const t0 = performance.now();
  const cache = opts.cache ?? await FileCache.open();
  const resolver = opts.resolver instanceof Resolver ? opts.resolver : await Resolver.load(opts.resolver);
  const index = new SparseIndex(opts.index, cache);
  for (let rounds = 1; ; rounds++) {
    const r = resolver.resolve(manifest);
    if ('error' in r) throw new Error(r.error);
    if ('lock' in r) return { lock: r.lock, packages: r.packages, rounds, index: index.stats, ms: Math.round(performance.now() - t0) };
    await inParallel(r.need, opts.concurrency ?? 16, async name => resolver.addIndex(name, await index.file(name)));
  }
}

export async function fetchDependencies(manifest: string, vfs: Pick<Vfs, 'writeFile'>, opts: DepsOptions): Promise<DepsResult> {
  const cache = opts.cache ?? await FileCache.open();
  const r = await resolveManifest(manifest, { ...opts, cache });
  const t0 = performance.now();
  const dir = opts.dir ?? '/deps';
  const crates: CrateStats[] = [];
  await inParallel(r.packages.filter(p => p.source === 'registry'), opts.concurrency ?? 16, async p => {
    const t = performance.now();
    if (!p.checksum) throw new Error(`${p.name} ${p.version}: no checksum in the index`);
    const { data, fromCache } = await fetchCrate(p.name, p.version, p.checksum, cache, opts.dl ?? CRATES_IO_DL);
    const files = await unpackCrate(data, vfs, dir, p.name, p.version);
    crates.push({ name: p.name, version: p.version, bytes: data.length, fromCache, files, ms: Math.round(performance.now() - t) });
  });
  return { ...r, ms: { resolve: r.ms, download: Math.round(performance.now() - t0) }, crates };
}
