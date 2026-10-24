// rustc's JSON diagnostics (--error-format=json --json=diagnostic-rendered-ansi) → CodeMirror lint
// diagnostics for one file, plus the rendered text for the terminal (WP-14).
import type { Diagnostic } from '@codemirror/lint';

interface Span { file_name: string; byte_start: number; byte_end: number; is_primary: boolean; label: string | null }
interface RustcDiagnostic {
  $message_type: 'diagnostic'; message: string; level: string; code: { code: string } | null;
  spans: Span[]; children: RustcDiagnostic[]; rendered: string | null;
}

export interface Parsed {
  /** For the editor: primary spans in `file`. */
  diagnostics: Diagnostic[];
  /** For the terminal: rustc's own rendering (ANSI colours) and any non-JSON lines (e.g. the linker's). */
  text: string;
  errors: number;
  warnings: number;
}

/** UTF-8 byte offset → UTF-16 offset in `source` (CodeMirror's positions). */
function byteOffsets(source: string) {
  const enc = new TextEncoder();
  return (byte: number) => {
    // Binary search on the prefix length in bytes; files here are small, so encode per probe.
    let lo = 0, hi = source.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (enc.encode(source.slice(0, mid)).length <= byte) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
}

export function parseRustcOutput(stderr: string, file: string, source: string): Parsed {
  const toPos = byteOffsets(source);
  const out: Parsed = { diagnostics: [], text: '', errors: 0, warnings: 0 };
  for (const line of stderr.split('\n')) {
    let d: RustcDiagnostic | null = null;
    if (line.startsWith('{')) { try { d = JSON.parse(line); } catch { /* not JSON after all */ } }
    if (!d || d.$message_type !== 'diagnostic') { if (line) out.text += line + '\n'; continue; }
    if (d.rendered) out.text += d.rendered;
    const severity = d.level.startsWith('error') ? 'error' : d.level === 'warning' ? 'warning' : 'info';
    // rustc's closing summaries ("aborting due to …", "N warnings emitted") are not diagnostics.
    const summary = d.spans.length === 0 && /^(aborting due to|\d+ warnings? emitted)/.test(d.message);
    if (d.level === 'error' && !summary) out.errors++;
    if (d.level === 'warning' && !summary) out.warnings++;
    const notes = d.children.map(c => `${c.level}: ${c.message}`);
    for (const s of d.spans) {
      if (!s.is_primary || s.file_name !== file) continue;
      const from = toPos(s.byte_start), to = Math.max(toPos(s.byte_end), from);
      const message = [d.code ? `${d.message} [${d.code.code}]` : d.message, s.label, ...notes].filter(Boolean).join('\n');
      out.diagnostics.push({ from, to, severity, message, source: 'rustc' });
    }
  }
  return out;
}
