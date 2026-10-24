// Loading a toolchain release (toolchain/release.sh) in the browser (WP-12): manifest.json, then each
// file by its name without `.br`. The server sends it with Content-Encoding: br, as a CDN would.
// Every file's sha256 is checked against the manifest. The bytes are kept in Cache Storage under the
// release's RUSTC_ID (immutable, so no revalidation), and compiled modules are kept for the page's life.

import { importedMemoryLimits } from '../wasi/process';

export interface ReleaseFile { file: string; size: number; sha256: string; brSize: number; brSha256: string }
export interface Manifest {
  RUSTC_ID: string; version: string; host: string; target: string;
  rustc: ReleaseFile; lld: ReleaseFile;
  sysroot: { meta: ReleaseFile & { files: number }; link: ReleaseFile & { files: number } };
}
export interface Tool { module: WebAssembly.Module; limits: { initial: number; maximum: number } }
export interface LoadStats { file: string; bytes: number; fromCache: boolean; ms: number }

const modules = new Map<string, Promise<Tool>>();

async function sha256(bytes: Uint8Array) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}

export class Release {
  private constructor(readonly base: string, readonly manifest: Manifest, private readonly cache: Cache | null) {}
  readonly stats: LoadStats[] = [];

  /** `base` is the release directory's URL, ending in /<RUSTC_ID>/. */
  static async open(base: string): Promise<Release> {
    const manifest: Manifest = await (await fetch(new URL('manifest.json', base), { cache: 'no-store' })).json();
    let cache: Cache | null = null;
    try { cache = await caches.open(`rust-toolchain-${manifest.RUSTC_ID}`); } catch { /* no Cache Storage (e.g. opaque origin) */ }
    return new Release(base, manifest, cache);
  }

  get id() { return this.manifest.RUSTC_ID; }

  /** The verified, uncompressed bytes of one release file. */
  async bytes(f: ReleaseFile): Promise<Uint8Array> {
    const t0 = performance.now();
    const url = new URL(f.file.replace(/\.br$/, ''), this.base).href;
    let res = await this.cache?.match(url);
    const fromCache = !!res;
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length !== f.size || (await sha256(data)) !== f.sha256) {
      if (fromCache) await this.cache!.delete(url);
      throw new Error(`${f.file}: size or sha256 does not match the manifest`);
    }
    if (!fromCache) await this.cache?.put(url, new Response(data as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/octet-stream' } }));
    this.stats.push({ file: f.file, bytes: data.length, fromCache, ms: Math.round(performance.now() - t0) });
    return data;
  }

  /** A compiled tool (rustc or lld), compiled once per page and release. */
  tool(which: 'rustc' | 'lld'): Promise<Tool> {
    const key = `${this.id}/${which}`;
    let t = modules.get(key);
    if (!t) {
      t = this.bytes(this.manifest[which]).then(async b => ({ module: await WebAssembly.compile(b as Uint8Array<ArrayBuffer>), limits: importedMemoryLimits(b) }));
      t.catch(() => modules.delete(key));
      modules.set(key, t);
    }
    return t;
  }
}
