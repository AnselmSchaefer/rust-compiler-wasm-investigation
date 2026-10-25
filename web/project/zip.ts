// Zip archives (WP-25), enough for project import/export: stored (0) and deflate (8) entries,
// no zip64, no encryption. Inflate/deflate come from the platform (`deflate-raw` streams).

const enc = new TextEncoder(), dec = new TextDecoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export interface ZipEntry { path: string; data: Uint8Array }

/** The files of a zip (directories left out), from its central directory. */
export async function readZip(zip: Uint8Array): Promise<ZipEntry[]> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // End of central directory: the last 0x06054b50, within the 64 KiB comment limit.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('zip: bad central directory');
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const path = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/')) continue;
    if (flags & 1) throw new Error(`zip: ${path} is encrypted`);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('zip: zip64 is not supported');
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + csize);
    const data = method === 0 ? raw.slice() : method === 8 ? await through(raw, new DecompressionStream('deflate-raw')) : null;
    if (!data) throw new Error(`zip: ${path}: compression method ${method} is not supported`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`zip: ${path} is corrupt`);
    out.push({ path, data });
  }
  return out;
}

/** A zip of `files` (deflated), with fixed timestamps so the same files give the same bytes. */
export async function writeZip(files: ZipEntry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1; // 1980-01-01 00:00
  for (const f of files) {
    const name = enc.encode(f.path), crc = crc32(f.data);
    const deflated = await through(f.data, new CompressionStream('deflate-raw'));
    const [method, body] = deflated.length < f.data.length ? [8, deflated] : [0, f.data];
    const header = (sig: number, size: number) => {
      const h = new Uint8Array(size), v = new DataView(h.buffer);
      v.setUint32(0, sig, true);
      return { h, v };
    };
    const { h: lh, v: l } = header(0x04034b50, 30 + name.length);
    l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(8, method, true);
    l.setUint16(10, DOS_TIME, true); l.setUint16(12, DOS_DATE, true); l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true); l.setUint32(22, f.data.length, true); l.setUint16(26, name.length, true);
    lh.set(name, 30);
    const { h: ch, v: c } = header(0x02014b50, 46 + name.length);
    c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(10, method, true);
    c.setUint16(12, DOS_TIME, true); c.setUint16(14, DOS_DATE, true); c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(38, 0o100644 << 16, true); c.setUint32(42, offset, true);
    ch.set(name, 46);
    parts.push(lh, body);
    central.push(ch);
    offset += lh.length + body.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}
