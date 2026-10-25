// A unified diff of two texts, by lines (WP-38: `cargo fmt --check` for agents). Longest common
// subsequence over lines, so fine for source files, not for huge inputs.

export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const a = before.split('\n'), b = after.split('\n');
  const n = a.length, m = b.length;
  // lcs[i][j]: LCS length of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ t: ' ', s: a[i], ai: i++, bi: j++ });
    // Removals before additions, as diff prints them.
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ t: '-', s: a[i], ai: i++, bi: j });
    else ops.push({ t: '+', s: b[j], ai: i, bi: j++ });
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (let k = 0; k < ops.length;) {
    if (ops[k].t === ' ') { k++; continue; }
    // A hunk: from `context` lines before this change to `context` after the last change near it.
    let start = Math.max(0, k - context), end = k;
    while (end < ops.length) {
      let next = end;
      while (next < ops.length && ops[next].t === ' ') next++;
      if (next === ops.length || next - end > 2 * context) break;
      while (next < ops.length && ops[next].t !== ' ') next++;
      end = next;
    }
    end = Math.min(ops.length, end + context);
    const h = ops.slice(start, end);
    const aLen = h.filter(o => o.t !== '+').length, bLen = h.filter(o => o.t !== '-').length;
    out.push(`@@ -${h[0].ai + 1},${aLen} +${h[0].bi + 1},${bLen} @@`, ...h.map(o => o.t + o.s));
    k = end;
  }
  return out.join('\n') + '\n';
}
