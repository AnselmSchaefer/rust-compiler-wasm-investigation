//! Target cfgs: which `[target.'cfg(..)'.dependencies]` apply, and the `CARGO_CFG_*` variables of
//! build scripts. The lists are `rustc --print cfg` of 1.99.1 with the crate types cargo asks for
//! (bin, rlib, dylib, cdylib, staticlib, proc-macro), which is why `crt-static` is missing.

use cargo_platform::{Cfg, Platform};
use std::collections::BTreeMap;
use std::str::FromStr;

const WASM32_WASIP1: &str = r#"debug_assertions
panic="abort"
target_abi=""
target_arch="wasm32"
target_endian="little"
target_env="p1"
target_family="wasm"
target_feature="bulk-memory"
target_feature="multivalue"
target_feature="mutable-globals"
target_feature="nontrapping-fptoint"
target_feature="reference-types"
target_feature="sign-ext"
target_has_atomic="16"
target_has_atomic="32"
target_has_atomic="64"
target_has_atomic="8"
target_has_atomic="ptr"
target_has_atomic_primitive_alignment="16"
target_has_atomic_primitive_alignment="32"
target_has_atomic_primitive_alignment="64"
target_has_atomic_primitive_alignment="8"
target_has_atomic_primitive_alignment="ptr"
target_os="wasi"
target_pointer_width="32"
target_vendor="unknown""#;

/// Only for the native golden tests, whose build scripts run on the machine that recorded them.
const X86_64_LINUX_GNU: &str = r#"debug_assertions
panic="unwind"
target_abi=""
target_arch="x86_64"
target_endian="little"
target_env="gnu"
target_family="unix"
target_feature="fxsr"
target_feature="sse"
target_feature="sse2"
target_has_atomic="16"
target_has_atomic="32"
target_has_atomic="64"
target_has_atomic="8"
target_has_atomic="ptr"
target_has_atomic_primitive_alignment="16"
target_has_atomic_primitive_alignment="32"
target_has_atomic_primitive_alignment="64"
target_has_atomic_primitive_alignment="8"
target_has_atomic_primitive_alignment="ptr"
target_os="linux"
target_pointer_width="64"
target_vendor="unknown"
unix"#;

pub struct TargetInfo {
    pub triple: String,
    pub cfgs: Vec<Cfg>,
    /// Suffix of executables: `.wasm` for wasm targets.
    pub exe_suffix: &'static str,
}

impl TargetInfo {
    pub fn new(triple: &str) -> Result<TargetInfo, String> {
        let (list, exe_suffix) = match triple {
            "wasm32-wasip1" => (WASM32_WASIP1, ".wasm"),
            "x86_64-unknown-linux-gnu" => (X86_64_LINUX_GNU, ""),
            _ => return Err(format!("unsupported target `{triple}`")),
        };
        let cfgs = list.lines().map(|l| Cfg::from_str(l).map_err(|e| e.to_string())).collect::<Result<_, _>>()?;
        Ok(TargetInfo { triple: triple.into(), cfgs, exe_suffix })
    }

    /// Whether a dependency's `target` (a `cfg(..)` expression or a triple) applies here.
    pub fn matches(&self, platform: &str) -> Result<bool, String> {
        let p = Platform::from_str(platform).map_err(|e| format!("target `{platform}`: {e}"))?;
        Ok(p.matches(&self.triple, &self.cfgs))
    }

    /// `CARGO_CFG_<KEY>` → comma-joined values, as cargo sets them for build scripts (the
    /// `debug_assertions` entry follows the profile, `feature` the unit's features).
    pub fn cargo_cfg_env(&self, debug_assertions: bool, features: &[String]) -> BTreeMap<String, String> {
        let mut env: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for cfg in &self.cfgs {
            let (k, v) = match cfg {
                Cfg::Name(n) => (n.as_str(), None),
                Cfg::KeyPair(k, v) => (k.as_str(), Some(v.clone())),
            };
            if k == "debug_assertions" {
                continue;
            }
            let e = env.entry(format!("CARGO_CFG_{}", k.to_uppercase())).or_default();
            e.extend(v);
        }
        if debug_assertions {
            env.insert("CARGO_CFG_DEBUG_ASSERTIONS".into(), Vec::new());
        }
        env.insert("CARGO_CFG_FEATURE".into(), features.to_vec());
        env.into_iter().map(|(k, v)| (k, v.join(","))).collect()
    }
}
