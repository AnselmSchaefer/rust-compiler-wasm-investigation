// .crate download and unpack (WP-16). static.crates.io allows CORS (Access-Control-Allow-Origin: *),
// so downloads go straight there. Every crate is checked against the sha256 the index (and so
// Cargo.lock) records, cached in OPFS (crates are immutable), gunzipped with the browser's
// DecompressionStream and untarred into the VFS.

import type { ByteStore } from './cache';
import type { Vfs } from '../vfs/vfs';
import { readTar } from '../orchestrator/tar';

export const CRATES_IO_DL = 'https://static.crates.io/crates';

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (d: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', d as Uint8Array<ArrayBuffer>));

export interface CrateStats { name: string; version: string; bytes: number; fromCache: boolean; files: number; ms: number }

/** The verified .crate bytes of `name` `version`. */
export async function fetchCrate(name: string, version: string, checksum: string, cache: ByteStore, dl = CRATES_IO_DL): Promise<{ data: Uint8Array; fromCache: boolean }> {
  const key = `crates/${name}-${version}.crate`;
  const cached = await cache.read(key);
  if (cached && await sha256(cached) === checksum) return { data: cached, fromCache: true };
  const res = await fetch(`${dl}/${name}/${name}-${version}.crate`);
  if (!res.ok) throw new Error(`${name} ${version}: download failed (HTTP ${res.status})`);
  const data = new Uint8Array(await res.arrayBuffer());
  const got = await sha256(data);
  if (got !== checksum) throw new Error(`${name} ${version}: checksum mismatch (expected ${checksum}, got ${got})`);
  await cache.write(key, data);
  return { data, fromCache: false };
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Unpacks a .crate into `dir` (cargo's layout: the archive's top-level `<name>-<version>/` becomes
 * `dir/<name>-<version>/`). Entries outside that directory are refused, as cargo does.
 */
export async function unpackCrate(crate: Uint8Array, vfs: Pick<Vfs, 'writeFile'>, dir: string, name: string, version: string): Promise<number> {
  const top = `${name}-${version}/`;
  let files = 0;
  for (const e of readTar(await gunzip(crate))) {
    if (!e.path.startsWith(top) || e.path.split('/').some(p => p === '..')) {
      throw new Error(`${name} ${version}: archive entry outside ${top}: ${e.path}`);
    }
    vfs.writeFile(`${dir}/${e.path}`, e.data);
    files++;
  }
  return files;
}
