// The build cache (WP-18): a unit's outputs, keyed by a hash of everything that goes into it.
// L1 is OPFS on this device; L2 is a read-only HTTP store shared by everyone (a CDN), filled by
// tools/prebuild, which runs the same rustc.wasm under wasmtime and computes the same keys.
//
// Key = sha256 over RUSTC_ID, the unit kind, the planned rustc arguments and environment (or the
// build script's), the package's source (a registry crate's checksum, or a hash of a path
// package's files) and the keys of the unit's dependencies. The planned arguments already name
// the target, features, profile and cargo's metadata hash. Build-script output that `finish` adds
// later is covered by the run unit's key, which is a dependency. Paths stay in the key: they're
// embedded in the outputs (debuginfo, file!()), so the browser and prebuild use the same layout:
// crates at /deps/<name>-<version>/, one target dir at /target.
//
// A bundle holds a unit's files (absolute VFS paths) and, for a build-script run, its stdout.

import type { ByteStore } from '../deps/cache';

const enc = new TextEncoder(), dec = new TextDecoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (d: Uint8Array | string) =>
  hex(await crypto.subtle.digest('SHA-256', (typeof d === 'string' ? enc.encode(d) : d) as Uint8Array<ArrayBuffer>));

/** Bump when the key or bundle format changes. */
const VERSION = 'wp18/1';
/** Environment that doesn't change a unit's outputs: NUM_JOBS is the worker count. */
const IGNORED_ENV = new Set(['NUM_JOBS']);

export interface KeyInput {
  rustcId: string; kind: string; args: string[]; env: Record<string, string>;
  /** sourceId() of the unit's package. */
  source: string;
  /** Keys of the unit's dependencies, in plan order. */
  deps: string[];
}

export function unitKey(k: KeyInput): Promise<string> {
  const env = Object.entries(k.env).filter(([n]) => !IGNORED_ENV.has(n)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(JSON.stringify([VERSION, k.rustcId, k.kind, k.args, env, k.source, k.deps]));
}

/** A registry crate is its .crate checksum; a path package is the hash of its files (path, sha256). */
export async function sourceId(pkg: { source: string; checksum: string | null }, files?: [string, Uint8Array][]): Promise<string> {
  if (pkg.source === 'registry') return `registry:${pkg.checksum}`;
  const lines = await Promise.all([...(files ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(async ([p, d]) => `${p}\0${await sha256(d)}\n`));
  return `path:${await sha256(lines.join(''))}`;
}

export interface BundleFile { path: string; data: Uint8Array; sha256: string }
/** `diagnostics` (WP-38): rustc's JSON diagnostics of the compile, replayed on a hit, as cargo does. */
export interface Bundle { files: BundleFile[]; stdout?: string; diagnostics?: unknown[] }

// "RCB1", u32 LE header length, header JSON { files: [{path, size, sha256}], stdout?, diagnostics? }, file data.
const MAGIC = [0x52, 0x43, 0x42, 0x31];

export async function makeBundle(files: [string, Uint8Array][], stdout?: string, diagnostics?: unknown[]): Promise<Bundle> {
  return { files: await Promise.all(files.map(async ([path, data]) => ({ path, data, sha256: await sha256(data) }))), stdout, ...(diagnostics?.length && { diagnostics }) };
}

export function encodeBundle(b: Bundle): Uint8Array {
  const header = enc.encode(JSON.stringify({ files: b.files.map(f => ({ path: f.path, size: f.data.length, sha256: f.sha256 })), stdout: b.stdout, diagnostics: b.diagnostics }));
  const out = new Uint8Array(8 + header.length + b.files.reduce((a, f) => a + f.data.length, 0));
  out.set(MAGIC);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  let o = 8 + header.length;
  for (const f of b.files) { out.set(f.data, o); o += f.data.length; }
  return out;
}

export function decodeBundle(bytes: Uint8Array): Bundle {
  if (bytes.length < 8 || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error('not a cache bundle');
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  const h = JSON.parse(dec.decode(bytes.subarray(8, 8 + len))) as { files: { path: string; size: number; sha256: string }[]; stdout?: string; diagnostics?: unknown[] };
  let o = 8 + len;
  const files = h.files.map(f => { const data = bytes.subarray(o, o += f.size); return { path: f.path, data, sha256: f.sha256 }; });
  if (o !== bytes.length) throw new Error('cache bundle has the wrong size');
  return { files, stdout: h.stdout, ...(h.diagnostics && { diagnostics: h.diagnostics }) };
}

/** Where a key's bundle lives, in L1 and below the L2 base URL. */
export const bundlePath = (key: string) => `${key.slice(0, 2)}/${key}`;

export type CacheLevel = 'l1' | 'l2';

export class UnitCache {
  readonly stats = { l1: 0, l2: 0, miss: 0, stored: 0, bytesIn: 0, bytesOut: 0 };

  /** `l1`: a writable store (OPFS); `l2`: a read-only base URL ending in '/'. Either may be missing. */
  constructor(private readonly l1: ByteStore | null, private readonly l2: string | null = null) {}

  async get(key: string): Promise<{ bundle: Bundle; from: CacheLevel } | null> {
    const local = await this.l1?.read(bundlePath(key));
    if (local) {
      this.stats.l1++;
      this.stats.bytesIn += local.length;
      return { bundle: decodeBundle(local), from: 'l1' };
    }
    if (this.l2) {
      let res: Response | null = null;
      try { res = await fetch(this.l2 + bundlePath(key)); } catch { /* offline */ }
      if (res?.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const bundle = decodeBundle(bytes);
        // L2 comes over the network: check every file before it reaches the build.
        for (const f of bundle.files) if (await sha256(f.data) !== f.sha256) throw new Error(`L2 bundle ${key}: ${f.path} doesn't match its hash`);
        await this.l1?.write(bundlePath(key), bytes);
        this.stats.l2++;
        this.stats.bytesIn += bytes.length;
        return { bundle, from: 'l2' };
      }
    }
    this.stats.miss++;
    return null;
  }

  async put(key: string, bundle: Bundle): Promise<void> {
    if (!this.l1) return;
    const bytes = encodeBundle(bundle);
    // A unit that can't be stored is built again next time; the build itself goes on.
    try { await this.l1.write(bundlePath(key), bytes); } catch { return; }
    this.stats.stored++;
    this.stats.bytesOut += bytes.length;
  }
}
