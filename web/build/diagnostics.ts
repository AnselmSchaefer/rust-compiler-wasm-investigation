// rustc's JSON diagnostics (`--error-format=json`) as data: what builds, checks and Clippy return
// (WP-26, WP-38), with rustc's rendered text kept for people.

export interface Diagnostic {
  level: string;
  message: string;
  /** `clippy::needless_return`, `E0308`, ... */
  code: string | null;
  /** The primary span. */
  file?: string; line?: number; column?: number;
  /** Where the primary span ends (WP-40: editor markers). */
  endLine?: number; endColumn?: number;
  rendered: string;
}

export function parseDiagnostics(stderr: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const l of stderr.split('\n')) {
    if (!l.startsWith('{')) continue;
    let d: any;
    try { d = JSON.parse(l); } catch { continue; }
    if (d.$message_type !== 'diagnostic' || !d.rendered) continue;
    // rustc's own summary ("2 warnings emitted") has no code and no spans.
    if (!d.spans?.length && !d.code && /^(aborting due to|\d+ warnings? emitted)/.test(d.message)) continue;
    const span = d.spans?.find((s: any) => s.is_primary) ?? d.spans?.[0];
    out.push({ level: d.level, message: d.message, code: d.code?.code ?? null, file: span?.file_name, line: span?.line_start, column: span?.column_start, endLine: span?.line_end, endColumn: span?.column_end, rendered: d.rendered });
  }
  return out;
}
