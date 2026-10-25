//! Native host of the `rust:proc-macro` world (WP-19 prototype). Two parts:
//!
//! - [`Guest`]: a Wasm proc-macro crate (built by pm-rewrite + pm_guest) instantiated under
//!   wasmtime. `expand` hands it the bridge's input bytes, answers its `dispatch` imports with a
//!   callback, and returns its output bytes.
//! - [`expand`]: runs one macro against a bridge server. Here the server is [`proxy::Proxy`],
//!   which implements `proc_macro::bridge::server::Server` on top of the public `proc_macro` API,
//!   so this crate can be used *inside a native proc macro*: native rustc → shim proc macro →
//!   Proxy server → Wasm client. In rustc.wasm (WP-20) the server would be rustc's own.
//!
//! How the bridge is driven: `ExecutionStrategy` can't be implemented outside `proc_macro` (its
//! signature names the private `Buffer`), so `expand` calls `Client::run1` with the stock
//! `SAME_THREAD` strategy on a `Client` whose `run` is [`trampoline`]. The strategy builds the
//! `BridgeConfig` (the encoded input and a closure over its dispatcher) and calls the trampoline,
//! which forwards both to the guest. The repr(C) mirrors are those of pm_guest (Rust 1.99.1).
//!
//! Needs `RUSTC_BOOTSTRAP=pm_host` (proc_macro internals).
#![feature(proc_macro_internals, proc_macro_span, proc_macro_diagnostic, proc_macro_expand, proc_macro_tracked_env, proc_macro_tracked_path, proc_macro_def_site)]
#![allow(internal_features)]

extern crate proc_macro;

pub mod proxy;
pub mod raw;

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use proc_macro::bridge::client::Client;
use proc_macro::bridge::server::SAME_THREAD;
use wasmtime::{Caller, Engine, Instance, Linker, Memory, Module, Store, TypedFunc};
use wasmtime_wasi::p1::{self, WasiP1Ctx};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::WasiCtxBuilder;

/// One macro of a guest, as `rust:proc-macro/client#macros` lists it.
#[derive(serde::Deserialize, Debug, Clone)]
pub struct MacroDecl {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub attributes: Vec<String>,
}

/// Time spent, for the overhead measurement.
#[derive(Default, Debug, Clone, Copy)]
pub struct Stats {
    pub calls: u64,
    pub dispatches: u64,
    /// Whole `expand` calls.
    pub total: Duration,
    /// Inside dispatch callbacks (the server's work, incl. the native bridge).
    pub server: Duration,
    /// The part of `server` spent in calls to the native compiler (the proxy's own work is the rest).
    pub native: Duration,
    /// Loading (compile or deserialize) and instantiating.
    pub load: Duration,
    /// Per bridge method (`ApiTags` order, the request's first byte): calls and server time.
    pub methods: [(u64, Duration); 32],
}

/// `ApiTags` order of Rust 1.99.1's `with_api!` (library/proc_macro/src/bridge/mod.rs).
pub const METHODS: [&str; 32] = [
    "injected_env_var", "track_env_var", "track_path", "literal_from_str", "emit_diagnostic", "ts_drop", "ts_clone",
    "ts_is_empty", "ts_expand_expr", "ts_from_str", "ts_to_string", "ts_from_token_tree", "ts_concat_trees",
    "ts_concat_streams", "ts_into_trees", "span_debug", "span_parent", "span_source", "span_byte_range", "span_start",
    "span_end", "span_line", "span_column", "span_file", "span_local_file", "span_join", "span_subspan",
    "span_resolved_at", "span_source_text", "span_save_span", "span_recover_proc_macro_span", "symbol_normalize_and_validate_ident",
];

/// Answers one bridge request: the request, and a sink that takes the reply.
pub type Dispatch<'a> = dyn FnMut(&[u8], &mut dyn FnMut(&[u8])) + 'a;

/// wasmtime wants `Send` store data; the callback is only used on the expanding thread.
#[derive(Clone, Copy)]
pub(crate) struct Callback(pub(crate) *mut Dispatch<'static>);
unsafe impl Send for Callback {}

struct HostState {
    wasi: WasiP1Ctx,
    /// The current expansion's dispatch callback (set only during `Guest::expand`).
    dispatch: Option<Callback>,
    dispatches: u64,
    /// The guest's memory and `cabi_realloc`, looked up once after instantiation.
    exports: Option<(Memory, TypedFunc<(u32, u32, u32, u32), u32>)>,
    /// A request's bytes, copied out of guest memory (reused).
    scratch: Vec<u8>,
}

/// A loaded Wasm proc macro: a pm_guest module, or a raw one (raw.rs).
pub enum AnyGuest {
    Glue(Guest),
    Raw(raw::RawGuest),
}

impl AnyGuest {
    pub fn load(path: &Path) -> wasmtime::Result<AnyGuest> {
        let module = load_module(path)?;
        Ok(if raw::RawGuest::is_raw(&module) { AnyGuest::Raw(raw::RawGuest::load(engine(), &module, path)?) } else { AnyGuest::Glue(Guest::instantiate(&module)?) })
    }
    pub fn macros(&self) -> &[MacroDecl] {
        match self {
            AnyGuest::Glue(g) => &g.macros,
            AnyGuest::Raw(g) => &g.macros,
        }
    }
    pub fn expand(&mut self, index: u32, input: &[u8], force_show_panics: bool, dispatch: &mut Dispatch<'_>) -> Result<Vec<u8>, String> {
        match self {
            AnyGuest::Glue(g) => g.expand(index, input, force_show_panics, dispatch),
            AnyGuest::Raw(g) => g.expand(index, input, force_show_panics, dispatch),
        }
    }
    pub fn dispatches(&self) -> u64 {
        match self {
            AnyGuest::Glue(g) => g.dispatches(),
            AnyGuest::Raw(g) => g.dispatches(),
        }
    }
}

pub struct Guest {
    store: Store<HostState>,
    memory: Memory,
    realloc: TypedFunc<(u32, u32, u32, u32), u32>,
    expand: TypedFunc<(u32, u32, u32, u32), u32>,
    post: TypedFunc<u32, ()>,
    stderr: MemoryOutputPipe,
    pub macros: Vec<MacroDecl>,
}

fn engine() -> &'static Engine {
    static ENGINE: std::sync::OnceLock<Engine> = std::sync::OnceLock::new();
    ENGINE.get_or_init(Engine::default)
}

/// The module, compiled once per machine: `<wasm>.<engine hash>.cwasm` next to it.
fn load_module(path: &Path) -> wasmtime::Result<Module> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    engine().precompile_compatibility_hash().hash(&mut h);
    let wasm = std::fs::read(path)?;
    wasm.hash(&mut h);
    let cached = path.with_extension(format!("{:016x}.cwasm", h.finish()));
    if let Ok(m) = unsafe { Module::deserialize_file(engine(), &cached) } {
        return Ok(m);
    }
    let m = Module::new(engine(), &wasm)?;
    let tmp = cached.with_extension("tmp");
    if std::fs::write(&tmp, m.serialize()?).is_ok() {
        let _ = std::fs::rename(&tmp, &cached);
    }
    Ok(m)
}

impl Guest {
    pub fn load(path: &Path) -> wasmtime::Result<Guest> {
        Guest::instantiate(&load_module(path)?)
    }

    fn instantiate(module: &Module) -> wasmtime::Result<Guest> {
        let mut linker: Linker<HostState> = Linker::new(engine());
        p1::add_to_linker_sync(&mut linker, |s: &mut HostState| &mut s.wasi)?;
        linker.func_wrap("rust:proc-macro/server@0.1.0", "dispatch", host_dispatch)?;
        let stderr = MemoryOutputPipe::new(1 << 20);
        let wasi = WasiCtxBuilder::new().stderr(stderr.clone()).build_p1();
        let mut store = Store::new(engine(), HostState { wasi, dispatch: None, dispatches: 0, exports: None, scratch: Vec::new() });
        let instance: Instance = linker.instantiate(&mut store, module)?;
        instance.get_typed_func::<(), ()>(&mut store, "_initialize")?.call(&mut store, ())?;
        let memory = instance.get_memory(&mut store, "memory").expect("guest exports memory");
        let macros_fn = instance.get_typed_func::<(), u32>(&mut store, "rust:proc-macro/client@0.1.0#macros")?;
        let ret = macros_fn.call(&mut store, ())?;
        let [ptr, len] = read_pair(&memory, &store, ret);
        let json = &memory.data(&store)[ptr as usize..(ptr + len) as usize];
        let macros: Vec<MacroDecl> = serde_json::from_slice(json)?;
        let realloc = instance.get_typed_func(&mut store, "cabi_realloc")?;
        store.data_mut().exports = Some((memory, realloc.clone()));
        Ok(Guest {
            realloc,
            expand: instance.get_typed_func(&mut store, "rust:proc-macro/client@0.1.0#expand")?,
            post: instance.get_typed_func(&mut store, "cabi_post_rust:proc-macro/client@0.1.0#expand")?,
            store,
            memory,
            stderr,
            macros,
        })
    }

    /// Run macro `index` on the bridge input `input`; `dispatch` answers each bridge request.
    pub fn expand(&mut self, index: u32, input: &[u8], force_show_panics: bool, dispatch: &mut Dispatch<'_>) -> Result<Vec<u8>, String> {
        let ptr = self.realloc.call(&mut self.store, (0, 0, 1, input.len() as u32)).map_err(|e| e.to_string())?;
        self.memory.write(&mut self.store, ptr as usize, input).map_err(|e| e.to_string())?;
        // The callback outlives this call only as a raw pointer in the store, cleared below.
        let d: *mut Dispatch<'_> = dispatch;
        self.store.data_mut().dispatch = Some(Callback(unsafe { std::mem::transmute::<*mut Dispatch<'_>, *mut Dispatch<'static>>(d) }));
        let r = self.expand.call(&mut self.store, (index, ptr, input.len() as u32, force_show_panics as u32));
        self.store.data_mut().dispatch = None;
        let ret = r.map_err(|e| {
            let stderr = String::from_utf8_lossy(&self.stderr.contents()).into_owned();
            format!("the Wasm proc macro trapped: {e}\n{stderr}")
        })?;
        let [p, l] = read_pair(&self.memory, &self.store, ret);
        let out = self.memory.data(&self.store)[p as usize..(p + l) as usize].to_vec();
        self.post.call(&mut self.store, ret).map_err(|e| e.to_string())?;
        Ok(out)
    }

    pub fn dispatches(&self) -> u64 {
        self.store.data().dispatches
    }
}

fn read_pair(memory: &Memory, store: impl wasmtime::AsContext, at: u32) -> [u32; 2] {
    let d = &memory.data(&store)[at as usize..at as usize + 8];
    [u32::from_le_bytes(d[..4].try_into().unwrap()), u32::from_le_bytes(d[4..].try_into().unwrap())]
}

/// Import `rust:proc-macro/server@0.1.0#dispatch(request: list<u8>) -> list<u8>`.
fn host_dispatch(mut caller: Caller<'_, HostState>, ptr: u32, len: u32, ret: u32) -> wasmtime::Result<()> {
    let (memory, realloc) = caller.data().exports.clone().expect("exports");
    let f = caller.data().dispatch.expect("dispatch outside of expand");
    let mut request = std::mem::take(&mut caller.data_mut().scratch);
    request.clear();
    request.extend_from_slice(&memory.data(&caller)[ptr as usize..(ptr + len) as usize]);
    caller.data_mut().dispatches += 1;
    let mut written: wasmtime::Result<()> = Ok(());
    unsafe {
        (*f.0)(&request, &mut |reply| {
            written = (|| -> wasmtime::Result<()> {
                // The guest lends the request's buffer for the reply when it fits (pm_guest).
                let p = if reply.is_empty() { 0 } else { realloc.call(&mut caller, (0, 0, 1, reply.len() as u32))? };
                memory.write(&mut caller, p as usize, reply)?;
                let mut pair = [0u8; 8];
                pair[..4].copy_from_slice(&p.to_le_bytes());
                pair[4..].copy_from_slice(&(reply.len() as u32).to_le_bytes());
                memory.write(&mut caller, ret as usize, &pair)?;
                Ok(())
            })();
        })
    };
    caller.data_mut().scratch = request;
    written
}

// --- driving the bridge (server side)

/// repr(C) mirrors of `proc_macro::bridge::{Buffer, Closure, BridgeConfig}` (see pm_guest).
#[repr(C)]
struct Buffer {
    data: *mut u8,
    len: usize,
    capacity: usize,
    reserve: extern "C" fn(Buffer, usize) -> Buffer,
    drop: extern "C" fn(Buffer),
}

impl Buffer {
    fn from_vec(v: Vec<u8>) -> Buffer {
        let mut v = std::mem::ManuallyDrop::new(v);
        extern "C" fn reserve(b: Buffer, additional: usize) -> Buffer {
            let mut v = unsafe { Vec::from_raw_parts(b.data, b.len, b.capacity) };
            v.reserve(additional);
            Buffer::from_vec(v)
        }
        extern "C" fn drop(b: Buffer) {
            std::mem::drop(unsafe { Vec::from_raw_parts(b.data, b.len, b.capacity) });
        }
        Buffer { data: v.as_mut_ptr(), len: v.len(), capacity: v.capacity(), reserve, drop }
    }
    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.data, self.len) }
    }
    fn free(self) {
        (self.drop)(self)
    }
}

#[repr(C)]
struct Closure {
    call: extern "C" fn(*mut (), Buffer) -> Buffer,
    env: *mut (),
}

#[repr(C)]
struct BridgeConfig {
    input: Buffer,
    dispatch: Closure,
    force_show_panics: bool,
}

struct Current {
    guest: *mut AnyGuest,
    index: u32,
    error: Option<String>,
    server: Duration,
}

thread_local! {
    static CURRENT: RefCell<Option<Current>> = const { RefCell::new(None) };
    static GUESTS: RefCell<HashMap<PathBuf, Box<AnyGuest>>> = RefCell::new(HashMap::new());
    pub static STATS: RefCell<Stats> = RefCell::new(Stats::default());
}

/// `Client::run` for every Wasm macro: the strategy's `BridgeConfig` goes to the guest.
extern "C" fn trampoline(config: BridgeConfig) -> Buffer {
    let BridgeConfig { input, dispatch, force_show_panics } = config;
    let (guest, index) = CURRENT.with_borrow(|c| {
        let c = c.as_ref().expect("trampoline outside of expand");
        (c.guest, c.index)
    });
    let mut server = Duration::ZERO;
    // One buffer goes back and forth: each reply buffer carries the next request.
    let mut cached: Option<Buffer> = None;
    let mut forward = |request: &[u8], sink: &mut dyn FnMut(&[u8])| {
        let t = Instant::now();
        let mut buf = cached.take().unwrap_or_else(|| Buffer::from_vec(Vec::new()));
        buf.len = 0;
        if buf.capacity < request.len() {
            buf = (buf.reserve)(buf, request.len());
        }
        unsafe { std::ptr::copy_nonoverlapping(request.as_ptr(), buf.data, request.len()) };
        buf.len = request.len();
        let reply = (dispatch.call)(dispatch.env, buf);
        let dt = t.elapsed();
        sink(reply.bytes());
        cached = Some(reply);
        server += dt;
        if let Some(&tag) = request.first() {
            STATS.with_borrow_mut(|s| {
                let m = &mut s.methods[tag as usize % 32];
                m.0 += 1;
                m.1 += dt;
            });
        }
    };
    // Unwinding out of an `extern "C"` fn aborts, so a trap becomes `Err(PanicMessage::Unknown)`
    // on the wire (Result tag 1, Option tag 1 = None); the message waits in CURRENT.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { &mut *guest }.expand(index, input.bytes(), force_show_panics, &mut forward)));
    input.free();
    if let Some(b) = cached {
        b.free();
    }
    let (out, error) = match result {
        Ok(Ok(out)) => (out, None),
        Ok(Err(e)) => (vec![1, 1], Some(e)),
        Err(_) => (vec![1, 1], Some("the Wasm proc macro host panicked".into())),
    };
    CURRENT.with_borrow_mut(|c| {
        let c = c.as_mut().unwrap();
        c.error = error;
        c.server = server;
    });
    Buffer::from_vec(out)
}

/// Expand `name` (a derive, or a function-like/attribute macro by function name) of the guest at
/// `path` with the Proxy server. `input2` is the item for attribute macros.
pub fn expand(path: &Path, kind: &str, name: &str, input: proc_macro::TokenStream, input2: Option<proc_macro::TokenStream>) -> proc_macro::TokenStream {
    let t0 = Instant::now();
    let guest: *mut AnyGuest = GUESTS.with_borrow_mut(|g| {
        let t = Instant::now();
        let guest = g.entry(path.to_path_buf()).or_insert_with(|| {
            Box::new(AnyGuest::load(path).unwrap_or_else(|e| panic!("loading the Wasm proc macro {}: {e:?}", path.display())))
        });
        STATS.with_borrow_mut(|s| s.load += t.elapsed());
        &mut **guest as *mut AnyGuest
    });
    let index = unsafe { &*guest }.macros().iter().position(|m| m.kind == kind && m.name == name)
        .unwrap_or_else(|| panic!("{} has no {kind} macro `{name}`", path.display())) as u32;
    let before = unsafe { &*guest }.dispatches();
    CURRENT.with_borrow_mut(|c| *c = Some(Current { guest, index, error: None, server: Duration::ZERO }));
    let native0 = proxy::NATIVE.get();
    // SAFETY: `Client` is `#[repr(C)] struct Client { run: extern "C" fn(BridgeConfig) -> Buffer }`.
    let client: Client = unsafe { std::mem::transmute::<extern "C" fn(BridgeConfig) -> Buffer, Client>(trampoline) };
    let r = match input2 {
        None => client.run1(&SAME_THREAD, proxy::Proxy::new(), input, false),
        Some(item) => client.run2(&SAME_THREAD, proxy::Proxy::new(), input, item, false),
    };
    let cur = CURRENT.with_borrow_mut(|c| c.take()).unwrap();
    STATS.with_borrow_mut(|s| {
        s.calls += 1;
        s.dispatches += unsafe { &*guest }.dispatches() - before;
        s.total += t0.elapsed();
        s.server += cur.server;
        s.native += proxy::NATIVE.get() - native0;
    });
    match r {
        Ok(ts) => ts,
        Err(m) => panic!("{}", cur.error.or_else(|| m.as_str().map(String::from)).unwrap_or_else(|| "the Wasm proc macro panicked".into())),
    }
}
