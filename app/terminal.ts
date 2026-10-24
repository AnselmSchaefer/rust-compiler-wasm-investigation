// The terminal (xterm.js): compiler output, the program's stdout/stderr, and a line discipline for
// its stdin: typed characters are echoed and sent a line at a time; Backspace edits the line,
// Ctrl-D ends input, Ctrl-C stops the program (WP-14).
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface StdinSink { write(s: string): void; closeStdin(): void; kill(): void }

export class Term {
  readonly xterm: Terminal;
  private readonly fit = new FitAddon();
  private sink: StdinSink | null = null;
  private line = '';

  constructor(el: HTMLElement) {
    this.xterm = new Terminal({ convertEol: true, fontSize: 13, cursorBlink: true, theme: { background: '#1e1e1e' } });
    this.xterm.loadAddon(this.fit);
    this.xterm.open(el);
    this.fit.fit();
    new ResizeObserver(() => this.fit.fit()).observe(el);
    this.xterm.onData(d => this.input(d));
  }

  write(s: string | Uint8Array) { this.xterm.write(s); }
  clear() { this.xterm.reset(); }

  /** Route typed input to a running program until detach(). */
  attach(sink: StdinSink) { this.sink = sink; this.line = ''; this.xterm.focus(); }
  detach() { this.sink = null; this.line = ''; }

  private input(data: string) {
    if (!this.sink) return;
    for (const ch of data) {
      if (ch === '\r') { this.xterm.write('\r\n'); this.sink.write(this.line + '\n'); this.line = ''; }
      else if (ch === '\x7f') { if (this.line) { this.line = this.line.slice(0, -1); this.xterm.write('\b \b'); } }
      else if (ch === '\x04') { if (this.line) this.sink.write(this.line); this.line = ''; this.sink.closeStdin(); }
      else if (ch === '\x03') { this.xterm.write('^C\r\n'); this.sink.kill(); }
      else if (ch >= ' ') { this.line += ch; this.xterm.write(ch); }
    }
  }
}
