#!/usr/bin/env bash
# WP-19 overhead: rustc's macro_expand_crate time (-Ztime-passes) for a generated crate with
# N structs and N enums, each #[derive(Serialize, Deserialize)] (4N macro calls), expanded by the
# native serde_derive and by serde_derive compiled to Wasm (pm-shim-serde), minus the same crate
# without derives. Two profiles: cargo's default (proc macros unoptimized) and proc macros at
# opt-level 3 (build-override). The guest is always a release build. Best of 5 interleaved runs.
#   tests/proc-macro/bench.sh <guest.wasm> <out.json> [N]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/toolchain/versions.env"
GUEST=$(realpath "$1"); OUT=$2; N=${3:-100}
B=$ROOT/build/wp-19/bench
mkdir -p "$B/src"
python3 -I - "$N" > "$B/src/lib.rs" <<'PY'
import sys
n = int(sys.argv[1])
print("#![allow(dead_code)]\n#[cfg(derives)] use serde_derive::{Deserialize, Serialize};\nuse std::collections::BTreeMap;")
for i in range(n):
    print(f"""
#[cfg_attr(derives, derive(Serialize, Deserialize))]
#[cfg_attr(derives, serde(rename_all = "camelCase"))]
pub struct Record{i}<'a> {{
    pub id_{i}: u64,
    pub name: String,
    #[cfg_attr(derives, serde(default, skip_serializing_if = "Option::is_none"))]
    pub note: Option<&'a str>,
    pub tags: Vec<String>,
    pub scores: BTreeMap<String, f64>,
    #[cfg_attr(derives, serde(rename = "flag"))]
    pub enabled: bool,
    pub pair: (i32, char),
    pub raw: [u8; 4],
}}

#[cfg_attr(derives, derive(Serialize, Deserialize))]
#[cfg_attr(derives, serde(tag = "kind"))]
pub enum Event{i} {{
    Start,
    Step {{ n: u32, label: String }},
    Stop {{ code: i64 }},
}}""")
PY
cases=()
for prof in dev opt3; do
  for v in none native wasm; do
    d=$B/$prof-$v; mkdir -p "$d"
    case $v in
      wasm) dep='serde_derive = { package = "pm-shim-serde", path = "'$ROOT'/crates/pm-bridge/shim-serde" }' ;;
      *) dep='serde_derive = "=1.0.229"' ;;
    esac
    {
      printf '[package]\nname = "bench"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "../src/lib.rs"\n\n[dependencies]\nserde = "=1.0.229"\n%s\n\n[workspace]\n' "$dep"
      [ $prof = opt3 ] && printf '\n[profile.dev.build-override]\nopt-level = 3\n'
    } > "$d/Cargo.toml"
    cp "$ROOT/tests/proc-macro/serde-demo/native/Cargo.lock" "$d/Cargo.lock" 2>/dev/null || true
    cases+=("$prof-$v")
  done
done
cfg() { [ "${1#*-}" = none ] && echo "" || echo "--cfg derives"; }
for c in "${cases[@]}"; do
  # Dependencies (and the shim) first.
  (cd "$B/$c" && PM_SERDE_DERIVE_WASM=$GUEST RUSTC_BOOTSTRAP=pm_host,bench cargo "+$RUST_TAG" build -q 2>/dev/null)
done
# Rounds over all cases (interleaved, so native and wasm see the same machine state); best per case.
declare -A best
for round in 1 2 3 4 5; do
  for c in "${cases[@]}"; do
    d=$B/$c
    rm -f "$d/stats.jsonl"
    t=$(cd "$d" && touch ../src/lib.rs && PM_STATS=$d/stats.jsonl PM_SERDE_DERIVE_WASM=$GUEST RUSTC_BOOTSTRAP=pm_host,bench \
      cargo "+$RUST_TAG" rustc -q --lib -- -Ztime-passes $(cfg $c) --check-cfg 'cfg(derives)' 2>&1 | awk '/\tmacro_expand_crate$/ {print $2}' | tr -d ';')
    [ -n "$t" ] || { echo "no macro_expand_crate time for $c" >&2; exit 1; }
    if [ -z "${best[$c]:-}" ] || awk "BEGIN{exit !($t < ${best[$c]})}"; then best[$c]=$t; [ -f "$d/stats.jsonl" ] && cp "$d/stats.jsonl" "$d/best-stats.jsonl"; fi
  done
done
for c in "${cases[@]}"; do echo "$c ${best[$c]}"; done > "$B/times.txt"
python3 -I - "$B" "$N" "$OUT" <<'PY'
import json, sys
b, n, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
t = dict((k, float(v) * 1000) for k, v in (l.split() for l in open(f"{b}/times.txt")))
calls = 4 * n
r = {"n": n, "calls": calls, "expand_ms": t, "profiles": {}}
for prof in ("dev", "opt3"):
    base = t[f"{prof}-none"]
    nat, wasm = t[f"{prof}-native"] - base, t[f"{prof}-wasm"] - base
    last = [json.loads(l) for l in open(f"{b}/{prof}-wasm/best-stats.jsonl")][-1]
    load = last["load_us"] / 1000
    p = {"native_ms": round(nat, 1), "wasm_ms": round(wasm, 1), "wasm_load_ms": round(load, 1),
         "native_us_per_call": round(nat * 1000 / calls), "wasm_us_per_call": round((wasm - load) * 1000 / calls),
         "ratio_per_call": round((wasm - load) / nat, 2), "ratio_incl_load": round(wasm / nat, 2),
         "dispatches_per_call": round(last["dispatches"] / last["calls"]), "server_share": round(last["server_us"] / last["total_us"], 2)}
    # The proxy's own work (decode, convert, re-encode) is what a server inside rustc wouldn't do.
    proxy = (last["server_us"] - last["native_us"]) / 1000
    p["proxy_us_per_call"] = round(proxy * 1000 / calls)
    p["est_ratio_without_proxy"] = round((wasm - load - proxy) / nat, 2)
    r["profiles"][prof] = p
    print(f"  {prof}: native {p['native_us_per_call']} us/call, wasm {p['wasm_us_per_call']} us/call ({p['ratio_per_call']}x; {p['ratio_incl_load']}x incl. {p['wasm_load_ms']} ms load), {p['dispatches_per_call']} bridge calls per expansion, {int(p['server_share']*100)}% of the wasm time in the server, {p['proxy_us_per_call']} us/call in the proxy itself (without it, est. {p['est_ratio_without_proxy']}x)")
json.dump(r, open(out, "w"), indent=2)
PY
