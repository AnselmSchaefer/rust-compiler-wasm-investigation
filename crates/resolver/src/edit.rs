//! Cargo.toml edits for agents (WP-25), formatting-preserving (toml_edit), with `cargo add` /
//! `cargo remove` conventions: a dependency is `name = "req"` when that's all it has, else an
//! inline table; it goes into `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`
//! or `[target.'<cfg>'.<kind>]`. Whether the result resolves is the caller's next step.

use serde::Deserialize;
use toml_edit::{Array, DocumentMut, InlineTable, Item, Table, Value};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Edit {
    /// Add or replace a dependency.
    Add {
        name: String,
        version: Option<String>,
        #[serde(default)]
        features: Vec<String>,
        #[serde(default)]
        optional: bool,
        #[serde(default = "yes")]
        default_features: bool,
        /// The registry package when `name` is a rename.
        package: Option<String>,
        path: Option<String>,
        #[serde(default)]
        kind: Kind,
        target: Option<String>,
    },
    Remove {
        name: String,
        #[serde(default)]
        kind: Kind,
        target: Option<String>,
    },
    /// Set (or, with `null`, remove) a value by key path, e.g. ["package", "edition"].
    Set { key: Vec<String>, value: serde_json::Value },
}

fn yes() -> bool {
    true
}

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Normal,
    Dev,
    Build,
}

impl Kind {
    fn table(self) -> &'static str {
        match self {
            Kind::Normal => "dependencies",
            Kind::Dev => "dev-dependencies",
            Kind::Build => "build-dependencies",
        }
    }
}

fn deps_table<'a>(doc: &'a mut DocumentMut, kind: Kind, target: Option<&str>, create: bool) -> Result<Option<&'a mut Table>, String> {
    let mut t = doc.as_table_mut();
    let mut path = Vec::new();
    if let Some(target) = target {
        path.push("target".to_string());
        path.push(target.to_string());
    }
    path.push(kind.table().to_string());
    for (i, k) in path.iter().enumerate() {
        if !t.contains_key(k) {
            if !create {
                return Ok(None);
            }
            let mut n = Table::new();
            // `[target.'cfg(..)'.dependencies]` without an empty `[target]` header above it.
            n.set_implicit(i + 1 < path.len());
            t.insert(k, Item::Table(n));
        }
        t = t.get_mut(k).and_then(Item::as_table_mut).ok_or_else(|| format!("`{}` is not a table", path[..=i].join(".")))?;
    }
    Ok(Some(t))
}

fn to_toml(v: &serde_json::Value) -> Result<Value, String> {
    Ok(match v {
        serde_json::Value::Bool(b) => (*b).into(),
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(i) => i.into(),
            None => n.as_f64().ok_or("bad number")?.into(),
        },
        serde_json::Value::String(s) => s.as_str().into(),
        serde_json::Value::Array(a) => Value::Array(a.iter().map(to_toml).collect::<Result<Array, _>>()?),
        serde_json::Value::Object(o) => {
            let mut t = InlineTable::new();
            for (k, v) in o {
                t.insert(k, to_toml(v)?);
            }
            Value::InlineTable(t)
        }
        serde_json::Value::Null => return Err("null only removes".into()),
    })
}

/// Applies `edits` in order to `manifest` and returns the new text.
pub fn apply(manifest: &str, edits: &[Edit]) -> Result<String, String> {
    let mut doc: DocumentMut = manifest.parse().map_err(|e| format!("parsing Cargo.toml: {e}"))?;
    for e in edits {
        match e {
            Edit::Add { name, version, features, optional, default_features, package, path, kind, target } => {
                if version.is_none() && path.is_none() {
                    return Err(format!("add `{name}`: give a version or a path"));
                }
                let simple = path.is_none() && package.is_none() && features.is_empty() && !optional && *default_features;
                let item = if simple {
                    Item::Value(version.as_deref().unwrap().into())
                } else {
                    let mut t = InlineTable::new();
                    if let Some(v) = version {
                        t.insert("version", v.as_str().into());
                    }
                    if let Some(p) = path {
                        t.insert("path", p.as_str().into());
                    }
                    if let Some(p) = package {
                        t.insert("package", p.as_str().into());
                    }
                    if !default_features {
                        t.insert("default-features", false.into());
                    }
                    if !features.is_empty() {
                        t.insert("features", Value::Array(features.iter().map(String::as_str).collect()));
                    }
                    if *optional {
                        t.insert("optional", true.into());
                    }
                    Item::Value(Value::InlineTable(t))
                };
                let t = deps_table(&mut doc, *kind, target.as_deref(), true)?.unwrap();
                t.insert(name, item);
            }
            Edit::Remove { name, kind, target } => {
                let removed = deps_table(&mut doc, *kind, target.as_deref(), false)?.and_then(|t| t.remove(name));
                if removed.is_none() {
                    return Err(format!("remove `{name}`: not in [{}]", kind.table()));
                }
            }
            Edit::Set { key, value } => {
                let (last, parents) = key.split_last().ok_or("set: empty key")?;
                let mut t = doc.as_table_mut();
                for (i, k) in parents.iter().enumerate() {
                    if !t.contains_key(k) {
                        if value.is_null() {
                            break;
                        }
                        t.insert(k, Item::Table(Table::new()));
                    }
                    t = t.get_mut(k).and_then(Item::as_table_mut).ok_or_else(|| format!("set: `{}` is not a table", key[..=i].join(".")))?;
                }
                if value.is_null() {
                    t.remove(last);
                } else {
                    t.insert(last, Item::Value(to_toml(value)?));
                }
            }
        }
    }
    Ok(doc.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edits(j: &str) -> Vec<Edit> {
        serde_json::from_str(j).unwrap()
    }

    #[test]
    fn add_remove_set() {
        let m = "[package]\nname = \"x\" # keep me\nversion = \"0.1.0\"\n\n[dependencies]\nitoa = \"1\"\n";
        let out = apply(m, &edits(r#"[
            {"op": "add", "name": "serde", "version": "1", "features": ["derive"]},
            {"op": "add", "name": "memchr", "version": "2"},
            {"op": "add", "name": "anyhow", "version": "1", "kind": "dev"},
            {"op": "add", "name": "libc", "version": "0.2", "target": "cfg(unix)"},
            {"op": "remove", "name": "itoa"},
            {"op": "set", "key": ["package", "edition"], "value": "2024"}
        ]"#)).unwrap();
        assert_eq!(out, "[package]\nname = \"x\" # keep me\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[dependencies]\nserde = { version = \"1\", features = [\"derive\"] }\nmemchr = \"2\"\n\n[dev-dependencies]\nanyhow = \"1\"\n\n[target.\"cfg(unix)\".dependencies]\nlibc = \"0.2\"\n");
        assert!(apply(m, &edits(r#"[{"op": "remove", "name": "nope"}]"#)).is_err());
    }
}
