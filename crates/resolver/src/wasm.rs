//! The browser entry point (wasm32-unknown-unknown, no bindings generator). JS owns fetching:
//!
//!   loop {
//!     resolver_resolve(manifest) → JSON
//!       {"need": [names]}            index files to fetch, then resolver_add_index(...) each, again
//!       {"lock": "...", "packages": [{name, version, source, checksum, features, deps}]}
//!       {"error": "..."}
//!   }
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
