// Sparse-index client (WP-16). index.crates.io sends no CORS headers, so the browser reads the
// index through a base URL on our side: in dev and tests, the pinned snapshot served by
// scripts/serve.mjs; when deployed, a same-origin proxy or CORS mirror ([H], see docs/deps.md).
// Network first, so the index stays fresh; the OPFS copy answers when offline.

import type { ByteStore } from './cache';

/** The path of a package's file in the index, e.g. `se/rd/serde`, `3/s/syn`, `2/cc`. */
export function indexPath(name: string): string {
  const n = name.toLowerCase();
  return n.length <= 2 ? `${n.length}/${n}` : n.length === 3 ? `3/${n[0]}/${n}` : `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

export interface IndexStats { fetched: number; fromCache: number; missing: number; bytes: number }

const NOT_FOUND = new TextEncoder().encode('\0not-found\0');
const isNotFound = (b: Uint8Array) => b.length === NOT_FOUND.length && b.every((x, i) => x === NOT_FOUND[i]);

export class SparseIndex {
  readonly stats: IndexStats = { fetched: 0, fromCache: 0, missing: 0, bytes: 0 };

  /** `base`: the index root, ending in '/'. */
  constructor(readonly base: string, private readonly cache: ByteStore) {}

  /** The index file of `name`, or null if the package doesn't exist. */
  async file(name: string): Promise<Uint8Array | null> {
    const path = indexPath(name), key = `index/${path}`;
    let res: Response | null = null;
    try {
      res = await fetch(this.base + path);
    } catch { /* offline: use the cache */ }
    if (res && (res.ok || res.status === 404)) {
      const data = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      await this.cache.write(key, data ?? NOT_FOUND);
      this.stats.fetched++;
      this.stats.bytes += data?.length ?? 0;
      if (!data) this.stats.missing++;
      return data;
    }
    const cached = await this.cache.read(key);
    if (!cached) throw new Error(`index file of \`${name}\`: ${res ? `HTTP ${res.status}` : 'offline'} and not cached`);
    this.stats.fromCache++;
    return isNotFound(cached) ? null : cached;
  }
}
