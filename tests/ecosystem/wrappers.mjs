// WP-22: one wrapper package per crate of a list (tests/ecosystem/top100.json): a lib that depends
// on `<name> = "=<version>"` with default features, so building it builds the crate as a
// dependency, the way a user's project would use it.
//   node tests/ecosystem/wrappers.mjs <list.json> <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [listFile, out] = process.argv.slice(2);
const { crates } = JSON.parse(readFileSync(listFile, 'utf8'));
for (const c of crates) {
  const d = `${out}/${c.name}`;
  mkdirSync(`${d}/src`, { recursive: true });
  writeFileSync(`${d}/Cargo.toml`, `[package]\nname = "eco-${c.name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n${c.name} = "=${c.version}"\n`);
  writeFileSync(`${d}/src/lib.rs`, '');
}
console.log(`${crates.length} wrappers in ${out}`);
