//! The browser entry point (wasm32-wasip1 with a few WASI stubs, no bindings generator). JS owns
//! fetching:
//!
//!   loop {
//!     resolver_resolve(manifest) → JSON
//!       {"need": [names]}            index files to fetch, then resolver_add_index(...) each, again
//!       {"lock": "...", "packages": [{name, version, source, checksum, features, deps}]}
//!       {"error": "..."}
//!   }
//!
//! The build planner (WP-17), on the same kind of JSON:
//!
//!   planner_plan(PlanInput) → {"plan": Plan} or {"error"}; the plan is kept for:
//!   planner_finish({"unit": id, "outputs": {"<run unit id>": "<stdout>"}}) → Finished or {"error"}
//!
//! Strings and bytes cross as (ptr, len) in this module's memory: JS gets a buffer with
//! resolver_alloc, writes into it, and passes it in (the callee frees it). A result is returned as
//! ptr << 32 | len; JS copies it out and calls resolver_free.

use crate::index::{IndexFile, Registry};
use crate::resolve::{IndexCache, resolve_cached};
use crate::summary::Source;
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};

#[derive(Default)]
struct State {
    /// name → index file (None: the package doesn't exist).
    files: HashMap<String, Option<Vec<u8>>>,
    cache: IndexCache,
    /// The last plan, with each package's `links`.
    plan: Option<(crate::plan::Plan, Vec<Option<String>>)>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// A registry over the files JS has supplied so far; asks for the rest.
struct Supplied<'a> {
    files: &'a HashMap<String, Option<Vec<u8>>>,
    missing: RefCell<BTreeSet<String>>,
}

impl Registry for Supplied<'_> {
    fn index_file(&self, name: &str) -> Result<IndexFile, String> {
        Ok(match self.files.get(name) {
            Some(Some(f)) => IndexFile::Found(f.clone()),
            Some(None) => IndexFile::NotFound,
            None => {
                self.missing.borrow_mut().insert(name.to_string());
                IndexFile::Pending
            }
        })
    }
}

unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
    unsafe { Vec::from_raw_parts(ptr, len, len) }
}

fn give(out: String) -> u64 {
    let b = out.into_bytes().into_boxed_slice();
    let len = b.len() as u64;
    let ptr = Box::into_raw(b) as *mut u8 as usize as u64;
    ptr << 32 | len
}

#[unsafe(no_mangle)]
pub extern "C" fn resolver_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from a result of this module.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn resolver_free(ptr: *mut u8, len: usize) {
    drop(unsafe { take(ptr, len) });
}

/// Supplies the index file of `name`; `present = 0` records that the package doesn't exist.
/// # Safety
/// Both buffers must come from `resolver_alloc` with these lengths; they are consumed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn resolver_add_index(name: *mut u8, name_len: usize, data: *mut u8, data_len: usize, present: u32) {
    let name = String::from_utf8(unsafe { take(name, name_len) }).unwrap_or_default();
    let data = unsafe { take(data, data_len) };
    STATE.with_borrow_mut(|s| {
        s.files.insert(name, (present != 0).then_some(data));
    });
}

/// # Safety
/// The manifest buffer must come from `resolver_alloc` with this length; it is consumed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn resolver_resolve(manifest: *mut u8, len: usize) -> u64 {
    let manifest = String::from_utf8(unsafe { take(manifest, len) }).unwrap_or_default();
    give(STATE.with_borrow_mut(|s| run(s, &manifest)).to_string())
}

fn run(state: &mut State, manifest: &str) -> serde_json::Value {
    use serde_json::json;
    let root = match crate::parse_manifest(manifest) {
        Ok(r) => r,
        Err(e) => return json!({ "error": e }),
    };
    let registry = Supplied { files: &state.files, missing: RefCell::default() };
    match resolve_cached(root, &registry, &mut state.cache) {
        Err(e) => json!({ "error": e }),
        Ok(None) => json!({ "need": registry.missing.into_inner() }),
        Ok(Some(r)) => {
            let packages: Vec<_> = r
                .packages
                .iter()
                .map(|p| {
                    json!({
                        "name": &*p.name,
                        "version": p.version.to_string(),
                        "source": match p.source { Source::Path => "path", Source::Registry => "registry" },
                        "checksum": p.checksum,
                        "features": p.features.iter().map(|f| &**f).collect::<Vec<_>>(),
                        "deps": p.deps,
                    })
                })
                .collect();
            json!({ "lock": crate::write_lockfile(&r), "packages": packages })
        }
    }
}

/// # Safety
/// The input buffer must come from `resolver_alloc` with this length; it is consumed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn planner_plan(input: *mut u8, len: usize) -> u64 {
    use serde_json::json;
    let input = unsafe { take(input, len) };
    let out = match serde_json::from_slice::<crate::plan::PlanInput>(&input) {
        Err(e) => json!({ "error": format!("bad plan input: {e}") }),
        Ok(input) => match crate::plan::plan(&input) {
            Err(e) => json!({ "error": e }),
            Ok(plan) => {
                let v = json!({ "plan": &plan });
                let links = input
                    .packages
                    .iter()
                    .map(|p| p.manifest.as_deref().and_then(|m| toml::from_str::<toml::Table>(m).ok()).and_then(|t| {
                        t.get("package")?.get("links")?.as_str().map(String::from)
                    }))
                    .collect();
                STATE.with_borrow_mut(|s| s.plan = Some((plan, links)));
                v
            }
        },
    };
    give(out.to_string())
}

/// # Safety
/// The input buffer must come from `resolver_alloc` with this length; it is consumed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn planner_finish(input: *mut u8, len: usize) -> u64 {
    use serde_json::{Value, json};
    let input: Value = serde_json::from_slice(&unsafe { take(input, len) }).unwrap_or_default();
    let out = STATE.with_borrow(|s| {
        let Some((plan, links)) = &s.plan else { return json!({ "error": "no plan" }) };
        let Some(id) = input["unit"].as_u64().map(|i| i as usize).filter(|&i| i < plan.units.len()) else {
            return json!({ "error": "bad unit" });
        };
        let outputs: HashMap<usize, String> = input["outputs"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| Some((k.parse().ok()?, v.as_str()?.to_string())))
            .collect();
        match crate::plan::finish(plan, &|p| links.get(p).cloned().flatten(), id, &outputs) {
            Ok(f) => json!(f),
            Err(e) => json!({ "error": e }),
        }
    });
    give(out.to_string())
}
