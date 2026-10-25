//! The Wasm side of the proc-macro bridge (WP-19). A proc-macro crate compiled for wasm32-wasip1
//! as a cdylib links this crate and invokes `export_proc_macros!`, which builds the same decls
//! array rustc's proc-macro harness would (`Client::expand1`/`expand2` per macro). This crate then
//! exports the `rust:proc-macro` world (`wit/proc-macro.wit`) in its canonical-ABI lowering:
//!
//! - `rust:proc-macro/client@0.1.0#macros() -> string`
//! - `rust:proc-macro/client@0.1.0#expand(index, input: list<u8>, force-show-panics) -> list<u8>`
//! - `cabi_realloc`, `cabi_post_…#expand`
//! - import `rust:proc-macro/server@0.1.0` `dispatch(request: list<u8>) -> list<u8>`
//!
//! `expand` calls the macro's `Client` the way a server's execution strategy does: with a
//! `BridgeConfig` whose input is the host's bytes and whose `dispatch` closure calls the import.
//! The bridge types are private to `proc_macro`, so they're mirrored here. They're `repr(C)` by
//! design (the bridge connects two `proc_macro` copies built by different compilers), and the
//! mirrors match Rust 1.99.1's `library/proc_macro/src/bridge/{buffer,closure,mod}.rs`. Check
//! them on every toolchain bump (WP-37).
//!
//! Building this crate needs `RUSTC_BOOTSTRAP=pm_guest` (for `allow_internal_unstable`); the macro
//! crate itself needs no unstable flags.
#![feature(allow_internal_unstable, allow_internal_unsafe)]
#![allow(internal_features)]

use std::alloc::{alloc, dealloc, realloc, Layout};
use std::mem::ManuallyDrop;
use std::ptr;

/// `proc_macro::bridge::buffer::Buffer`.
#[repr(C)]
pub struct Buffer {
    data: *mut u8,
    len: usize,
    capacity: usize,
    reserve: extern "C" fn(Buffer, usize) -> Buffer,
    drop: extern "C" fn(Buffer),
}

impl Buffer {
    /// As `impl From<Vec<u8>> for Buffer` in proc_macro.
    fn from_vec(v: Vec<u8>) -> Buffer {
        let mut v = ManuallyDrop::new(v);
        extern "C" fn reserve(b: Buffer, additional: usize) -> Buffer {
            let mut v = unsafe { b.into_vec() };
            v.reserve(additional);
            Buffer::from_vec(v)
        }
        extern "C" fn drop(b: Buffer) {
            std::mem::drop(unsafe { b.into_vec() });
        }
        Buffer { data: v.as_mut_ptr(), len: v.len(), capacity: v.capacity(), reserve, drop }
    }

    /// Only for buffers made by `from_vec` (in this module, with this allocator).
    unsafe fn into_vec(self) -> Vec<u8> {
        unsafe { Vec::from_raw_parts(self.data, self.len, self.capacity) }
    }

    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.data, self.len) }
    }

    /// Free with the buffer's own `drop`: it may come from either side of the bridge.
    fn free(self) {
        (self.drop)(self)
    }
}

/// `proc_macro::bridge::closure::Closure`.
#[repr(C)]
struct Closure {
    call: extern "C" fn(*mut (), Buffer) -> Buffer,
    env: *mut (),
}

/// `proc_macro::bridge::BridgeConfig`.
#[repr(C)]
struct BridgeConfig {
    input: Buffer,
    dispatch: Closure,
    force_show_panics: bool,
}

/// `proc_macro::bridge::client::Client` is a `repr(C)` struct holding just this.
type RunClient = extern "C" fn(BridgeConfig) -> Buffer;

/// What `export_proc_macros!` hands over: the decls array and the macros' JSON description.
#[repr(C)]
#[doc(hidden)]
pub struct Decls {
    pub clients: *const (),
    pub len: usize,
    pub macros: *const u8,
    pub macros_len: usize,
}

unsafe extern "C" {
    /// Defined by `export_proc_macros!` in the macro crate.
    fn __pm_decls(out: *mut Decls);
}

fn decls() -> Decls {
    let mut d = Decls { clients: ptr::null(), len: 0, macros: ptr::null(), macros_len: 0 };
    unsafe { __pm_decls(&mut d) };
    d
}

/// Export the crate's proc macros, in declaration order, as the `rust:proc-macro` world.
/// `kind` is `expand1` (derive, function-like) or `expand2` (attribute), as in rustc's harness.
///
/// ```ignore
/// pm_guest::export_proc_macros!(r#"[{"kind":"derive","name":"Serialize","attributes":["serde"]}]"#;
///     expand1 derive_serialize);
/// ```
#[macro_export]
#[allow_internal_unstable(proc_macro_internals)]
#[allow_internal_unsafe]
macro_rules! export_proc_macros {
    ($macros:literal; $($kind:ident $f:path),* $(,)?) => {
        const _: () = {
            #[allow(deprecated)]
            static DECLS: &[::proc_macro::bridge::client::Client] =
                &[$(::proc_macro::bridge::client::Client::$kind($f)),*];

            #[unsafe(no_mangle)]
            extern "C" fn __pm_decls(out: *mut $crate::Decls) {
                let macros: &'static str = $macros;
                unsafe {
                    *out = $crate::Decls {
                        clients: DECLS.as_ptr().cast(),
                        len: DECLS.len(),
                        macros: macros.as_ptr(),
                        macros_len: macros.len(),
                    };
                }
            }
        };
    };
}

#[link(wasm_import_module = "rust:proc-macro/server@0.1.0")]
unsafe extern "C" {
    /// `dispatch(request: list<u8>) -> list<u8>`: the host writes the reply's (ptr, len) to
    /// `ret`, allocated in our memory with `cabi_realloc` (align 1); we own it afterwards.
    #[link_name = "dispatch"]
    fn server_dispatch(ptr: *const u8, len: usize, ret: *mut [usize; 2]);
}

/// The request buffer while the host answers it: `cabi_realloc` hands it out for the reply when
/// it's big enough, so a round trip allocates nothing (the client keeps the buffer it gets back).
static mut LENDING: Option<(*mut u8, usize)> = None;

/// The bridge's `dispatch` closure: one request out to the host, its reply back.
extern "C" fn dispatch(_env: *mut (), request: Buffer) -> Buffer {
    let mut ret = [0usize; 2];
    unsafe {
        LENDING = Some((request.data, request.capacity));
        server_dispatch(request.data, request.len, &mut ret);
        LENDING = None;
    }
    if ret[0] == request.data as usize && ret[1] <= request.capacity {
        return Buffer { len: ret[1], ..request };
    }
    request.free();
    Buffer::from_vec(unsafe { owned_list(ret) })
}

/// A `list<u8>` the host allocated with `cabi_realloc(0, 0, 1, len)`.
unsafe fn owned_list([ptr, len]: [usize; 2]) -> Vec<u8> {
    if len == 0 {
        return Vec::new();
    }
    unsafe { Vec::from_raw_parts(ptr as *mut u8, len, len) }
}

/// Return area for list results (the canonical ABI returns lists through memory).
static mut RET: [usize; 2] = [0; 2];

#[unsafe(export_name = "rust:proc-macro/client@0.1.0#expand")]
pub unsafe extern "C" fn expand(index: u32, ptr: usize, len: usize, force_show_panics: u32) -> *const [usize; 2] {
    let d = decls();
    assert!((index as usize) < d.len, "proc macro {index} of {}", d.len);
    let run = unsafe { *(d.clients as *const RunClient).add(index as usize) };
    let input = Buffer::from_vec(unsafe { owned_list([ptr, len]) });
    let output = run(BridgeConfig {
        input,
        dispatch: Closure { call: dispatch, env: ptr::null_mut() },
        force_show_panics: force_show_panics != 0,
    });
    // A boxed slice, so `cabi_post` knows the capacity.
    let out: Box<[u8]> = output.bytes().into();
    output.free();
    let out = Box::into_raw(out);
    unsafe {
        RET = [out as *mut u8 as usize, out.len()];
        &raw const RET
    }
}

#[unsafe(export_name = "cabi_post_rust:proc-macro/client@0.1.0#expand")]
pub unsafe extern "C" fn expand_post(ret: *const [usize; 2]) {
    let [ptr, len] = unsafe { *ret };
    if len > 0 {
        drop(unsafe { Box::from_raw(ptr::slice_from_raw_parts_mut(ptr as *mut u8, len)) });
    }
}

#[unsafe(export_name = "rust:proc-macro/client@0.1.0#macros")]
pub unsafe extern "C" fn macros() -> *const [usize; 2] {
    let d = decls();
    unsafe {
        RET = [d.macros as usize, d.macros_len];
        &raw const RET
    }
}

/// The canonical ABI's allocator: the host allocates `list<u8>` arguments and results with it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cabi_realloc(old: *mut u8, old_size: usize, align: usize, new_size: usize) -> *mut u8 {
    if old_size == 0 && align == 1 {
        if let Some((data, capacity)) = unsafe { ptr::replace(&raw mut LENDING, None) } {
            if new_size <= capacity {
                return data;
            }
        }
    }
    if new_size == 0 {
        if old_size != 0 {
            unsafe { dealloc(old, Layout::from_size_align_unchecked(old_size, align)) };
        }
        return align as *mut u8;
    }
    let p = unsafe {
        if old_size == 0 {
            alloc(Layout::from_size_align_unchecked(new_size, align))
        } else {
            realloc(old, Layout::from_size_align_unchecked(old_size, align), new_size)
        }
    };
    if p.is_null() {
        std::process::abort();
    }
    p
}

/// A reactor's entry point. rustc links no crt1 object into a wasm cdylib, so without this
/// wasm-ld would treat the module as a command and wrap every export in constructor/destructor
/// calls, including `cabi_realloc` while the host answers `dispatch`. The host calls it once.
#[unsafe(export_name = "_initialize")]
pub extern "C" fn initialize() {
    unsafe extern "C" {
        fn __wasm_call_ctors();
    }
    unsafe { __wasm_call_ctors() };
}
