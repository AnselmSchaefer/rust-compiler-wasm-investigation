//! What a build script prints: `cargo:KEY=VALUE` (old) and `cargo::KEY=VALUE` (1.77+) lines,
//! parsed like cargo's `BuildOutput::parse`, and how they change the package's rustc invocation.

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct BuildOutput {
    pub cfgs: Vec<String>,
    pub check_cfgs: Vec<String>,
    pub env: Vec<(String, String)>,
    /// `-l` values (`[KIND[:MODIFIERS]=]NAME[:RENAME]`).
    pub link_libs: Vec<String>,
    /// `-L` values (`[KIND=]PATH`).
    pub link_search: Vec<String>,
    /// `-C link-arg=` values for binaries of this package.
    pub link_args: Vec<String>,
    /// `cargo::metadata=K=V` (or an unknown old-style key): `DEP_<LINKS>_<K>` for dependents.
    pub metadata: Vec<(String, String)>,
    pub rerun_if_changed: Vec<String>,
    pub rerun_if_env_changed: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

impl BuildOutput {
    pub fn parse(stdout: &str, pkg: &str) -> Result<BuildOutput, String> {
        let mut out = BuildOutput::default();
        for line in stdout.lines() {
            let (new_syntax, data) = match line.strip_prefix("cargo::") {
                Some(d) => (true, d),
                None => match line.strip_prefix("cargo:") {
                    Some(d) => (false, d),
                    None => continue,
                },
            };
            let Some((key, value)) = data.split_once('=') else {
                if new_syntax {
                    return Err(format!("{pkg}: invalid build-script output `{line}`: expected `cargo::KEY=VALUE`"));
                }
                continue;
            };
            let (key, value) = (key.trim(), value.trim_end_matches(['\r']));
            match key {
                "rustc-flags" => {
                    let mut words = value.split_whitespace();
                    while let Some(w) = words.next() {
                        let (flag, v) = if w.len() > 2 && (w.starts_with("-l") || w.starts_with("-L")) {
                            (&w[..2], w[2..].to_string())
                        } else {
                            (w, words.next().ok_or_else(|| format!("{pkg}: `{w}` without a value in rustc-flags"))?.to_string())
                        };
                        match flag {
                            "-l" => out.link_libs.push(v),
                            "-L" => out.link_search.push(v),
                            _ => return Err(format!("{pkg}: only -l and -L are allowed in rustc-flags, not `{flag}`")),
                        }
                    }
                }
                "rustc-link-lib" => out.link_libs.push(value.into()),
                "rustc-link-search" => out.link_search.push(value.into()),
                "rustc-link-arg" | "rustc-link-arg-bins" => out.link_args.push(value.into()),
                k if k.starts_with("rustc-link-arg-") => {} // tests, examples, benches, one bin: not built here
                "rustc-cfg" => out.cfgs.push(value.into()),
                "rustc-check-cfg" => out.check_cfgs.push(value.into()),
                "rustc-env" => {
                    let (k, v) = value.split_once('=').ok_or_else(|| format!("{pkg}: rustc-env `{value}` needs KEY=VALUE"))?;
                    out.env.push((k.into(), v.into()));
                }
                "warning" => out.warnings.push(value.into()),
                "error" => out.errors.push(value.into()),
                "rerun-if-changed" => out.rerun_if_changed.push(value.into()),
                "rerun-if-env-changed" => out.rerun_if_env_changed.push(value.into()),
                "metadata" if new_syntax => {
                    let (k, v) = value.split_once('=').ok_or_else(|| format!("{pkg}: metadata `{value}` needs KEY=VALUE"))?;
                    out.metadata.push((k.into(), v.into()));
                }
                _ if new_syntax => return Err(format!("{pkg}: unknown build-script instruction `{line}`")),
                k => out.metadata.push((k.into(), value.into())),
            }
        }
        Ok(out)
    }

    /// Adds this output to the rustc invocation of a lib or bin of its package, in cargo's order.
    pub fn apply(&self, args: &mut Vec<String>, env: &mut BTreeMap<String, String>, is_bin: bool) {
        for s in &self.link_search {
            args.extend(["-L".into(), s.clone()]);
        }
        for l in &self.link_libs {
            args.extend(["-l".into(), l.clone()]);
        }
        if is_bin {
            for a in &self.link_args {
                args.extend(["-C".into(), format!("link-arg={a}")]);
            }
        }
        for c in &self.cfgs {
            args.extend(["--cfg".into(), c.clone()]);
        }
        for c in &self.check_cfgs {
            args.extend(["--check-cfg".into(), c.clone()]);
        }
        for (k, v) in &self.env {
            env.insert(k.clone(), v.clone());
        }
    }
}
