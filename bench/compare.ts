// Diff two bench results: `node bench/compare.ts old.json new.json`.
// Prints every numeric median/size that appears in both files, with the relative change.
import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, 'utf8')));
if (!a || !b) { console.error('usage: node bench/compare.ts old.json new.json'); process.exit(2); }

// Flatten to "browsers.chromium.steps.build-hello" → median (Stat objects) or plain numbers.
function flatten(o: unknown, prefix = '', out = new Map<string, number>()) {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    const rec = o as Record<string, unknown>;
    if (typeof rec.median === 'number') out.set(prefix, rec.median);
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'runs' || k === 'first' || k === 'median' || k === 'min') continue;
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (typeof o === 'number' && !/^(iters|machine)/.test(prefix)) {
    out.set(prefix, o);
  }
  return out;
}

const fa = flatten(a), fb = flatten(b);
const rows = [...fa.keys()].filter(k => fb.has(k)).map(k => {
  const [x, y] = [fa.get(k)!, fb.get(k)!];
  const pct = x === 0 ? 0 : ((y - x) / x) * 100;
  return [k, String(x), String(y), `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`];
});
console.log(`${a.commit} (${a.date.slice(0, 10)}) → ${b.commit} (${b.date.slice(0, 10)})`);
const w = [0, 1, 2, 3].map(i => Math.max(...rows.map(r => r[i].length), 6));
for (const r of [['metric', 'old', 'new', 'change'], ...rows]) {
  console.log(r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  '));
}
