// A one-way byte pipe in a SharedArrayBuffer: the page writes (stdin typed into a terminal, or
// given up front), a sandboxed program reads and blocks while it is empty (WP-13).
//
// Layout: Int32 [readPos, writePos, closed] then CAPACITY data bytes (a ring). Positions only grow
// (mod 2^31 is far beyond any session's input); the writer never overwrites unread bytes.

const R = 0, W = 1, CLOSED = 2, HEADER = 16;
export const PIPE_CAPACITY = 1 << 16;

export function createPipe(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER + PIPE_CAPACITY);
}

export class PipeWriter {
  private readonly h: Int32Array;
  private readonly data: Uint8Array;
  private queued: Uint8Array[] = [];
  constructor(sab: SharedArrayBuffer) {
    this.h = new Int32Array(sab, 0, 3);
    this.data = new Uint8Array(sab, HEADER);
  }

  /** Queue bytes; what doesn't fit now is written as the reader drains (call pump() or write again). */
  write(bytes: Uint8Array) {
    if (Atomics.load(this.h, CLOSED)) throw new Error('pipe closed');
    this.queued.push(bytes);
    this.pump();
  }

  /** Move queued bytes into the ring; returns whether everything has been written. */
  pump(): boolean {
    while (this.queued.length) {
      const r = Atomics.load(this.h, R), w = Atomics.load(this.h, W);
      const room = PIPE_CAPACITY - (w - r);
      if (room === 0) break;
      const chunk = this.queued[0], n = Math.min(room, chunk.length);
      for (let i = 0; i < n; i++) this.data[(w + i) % PIPE_CAPACITY] = chunk[i];
      Atomics.store(this.h, W, w + n);
      Atomics.notify(this.h, W);
      if (n === chunk.length) this.queued.shift();
      else this.queued[0] = chunk.subarray(n);
    }
    return this.queued.length === 0;
  }

  /** End of input, once the queued bytes are read. */
  close() {
    const finish = () => {
      if (!this.pump()) return void setTimeout(finish, 1);
      Atomics.store(this.h, CLOSED, 1);
      Atomics.notify(this.h, W);
    };
    finish();
  }
}

/** Blocking reads, for the sandbox worker (Atomics.wait is allowed in workers). */
export class PipeReader {
  private readonly h: Int32Array;
  private readonly data: Uint8Array;
  constructor(sab: SharedArrayBuffer) {
    this.h = new Int32Array(sab, 0, 3);
    this.data = new Uint8Array(sab, HEADER);
  }

  /** Fill `bufs` with what is available, waiting for at least one byte; 0 = end of input. */
  read(bufs: Uint8Array[]): number {
    for (;;) {
      const r = Atomics.load(this.h, R), w = Atomics.load(this.h, W);
      if (w > r) {
        let pos = r, total = 0;
        for (const b of bufs) {
          const n = Math.min(b.length, w - pos);
          for (let i = 0; i < n; i++) b[i] = this.data[(pos + i) % PIPE_CAPACITY];
          pos += n;
          total += n;
          if (pos === w) break;
        }
        Atomics.store(this.h, R, pos);
        return total;
      }
      if (Atomics.load(this.h, CLOSED)) return 0;
      Atomics.wait(this.h, W, w, 1000);
    }
  }
}
