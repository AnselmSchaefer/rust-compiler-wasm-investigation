// WP-18 determinism check: a browser build's units (bench/results/*-cache.json, from
// tests/e2e/cache.spec.ts) against tools/prebuild's wasmtime build of the same cases (its
// --report). Same key ⇒ same output files, bit for bit. Usage: node tests/cache/compare.mjs BROWSER PREBUILD
import { readFileSync } from 'node:fs';

const [browser, prebuild] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, 'utf8')));
let units = 0, bad = 0;
const crates = new Set();
for (const [name, list] of Object.entries(browser.units)) {
  const native = new Map(prebuild.cases[name].units.map(u => [`${u.name} ${u.version} ${u.kind}`, u]));
  for (const u of list) {
    const id = `${u.name} ${u.version} ${u.kind}`, n = native.get(id);
    units++;
    if (!n) { bad++; console.log(`  MISSING in prebuild: ${name}: ${id}`); continue; }
    if (n.key !== u.key) { bad++; console.log(`  KEY ${name}: ${id}: browser ${u.key.slice(0, 12)} wasmtime ${n.key.slice(0, 12)}`); continue; }
    const diff = Object.keys({ ...u.files, ...n.files }).filter(f => u.files[f] !== n.files[f]);
    // A build script's stdout is the part of its output that its package's compile reads (WP-21).
    if ((u.stdout ?? '') !== (n.stdout ?? '')) diff.push('stdout');
    if (diff.length) { bad++; console.log(`  OUTPUT ${name}: ${id}: ${diff.join(', ')}`); continue; }
    if (u.name !== name) crates.add(`${u.name} ${u.version}`);
  }
  if (native.size !== list.length) { bad++; console.log(`  ${name}: browser ${list.length} units, prebuild ${native.size}`); }
}
console.log(`  ${units} units compared, ${crates.size} registry crates with identical keys and outputs, ${bad} mismatches`);
process.exit(bad || crates.size < 20 ? 1 : 0);
