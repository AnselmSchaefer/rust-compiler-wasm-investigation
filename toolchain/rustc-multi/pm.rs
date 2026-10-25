// Wasm proc macros in rustc.wasm (WP-20), the driver's side. rustc finds a proc-macro crate built
// for wasm32-wasip1 (rust-lang/rust#160981, behind `wasm_proc_macros`, which `main.rs` turns on)
// and asks the loader registered here for its `&'static [Client]` table
// (`rustc_metadata::register_wasm_proc_macro_loader`, the user's change).
//
// A `Client` is just `extern "C" fn(BridgeConfig) -> Buffer`, with no room for which macro it is.
// So each macro gets a *slot*: `slot::<N>` is a distinct function, and `SLOTS[N]` says which
// module and which of its macros it runs. `slot::<N>` copies the bridge input into a scratch
// buffer and asks the JS host (import module `rust_pm`) to run the macro. The host instantiates
// the module in this worker and drives its stock proc_macro client (web/wasi/proc-macro.ts, a
// port of crates/pm-bridge/host/src/raw.rs). For each bridge request of the macro, the host
// calls `host_call` through rustc's function table (exported functions of a command module would
// re-run constructors): it reserves scratch space, or sends the request through the
// `BridgeConfig`'s dispatch closure, i.e. rustc's real proc-macro server, and leaves the reply in
// the scratch buffer.
//
// `Buffer`, `Closure` and `BridgeConfig` are private to proc_macro but `repr(C)`; the mirrors
// below follow Rust 1.99.1's library/proc_macro/src/bridge (check on every toolchain bump).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rustc_proc_macro::bridge::client::Client;

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

/// Shared with the JS host (it reads and writes these fields in rustc's memory): wasm32 layout,
/// seven u32 words.
#[repr(C)]
struct Ctx {
    /// Table index of `host_call`.
    helper: u32,
    /// The scratch buffer: request, reply, input and output bytes in turn.
    ptr: u32,
    len: u32,
    cap: u32,
    /// The bridge's dispatch closure for this expansion.
    call: u32,
    env: u32,
    /// The module's version, from `load` (the host reloads when the file changed).
    version: u32,
}

impl Ctx {
    fn new(version: u32, dispatch: Option<&Closure>) -> Ctx {
        Ctx {
            helper: host_call as extern "C" fn(*mut Ctx, u32, u32) -> u32 as usize as u32,
            ptr: 0,
            len: 0,
            cap: 0,
            call: dispatch.map_or(0, |d| d.call as usize as u32),
            env: dispatch.map_or(0, |d| d.env as usize as u32),
            version,
        }
    }
    fn take(&mut self) -> Vec<u8> {
        if self.cap == 0 {
            return Vec::new();
        }
        let v = unsafe { Vec::from_raw_parts(self.ptr as usize as *mut u8, self.len as usize, self.cap as usize) };
        (self.ptr, self.len, self.cap) = (0, 0, 0);
        v
    }
    fn put(&mut self, v: Vec<u8>) {
        let mut v = std::mem::ManuallyDrop::new(v);
        (self.ptr, self.len, self.cap) = (v.as_mut_ptr() as usize as u32, v.len() as u32, v.capacity() as u32);
    }
}

impl Drop for Ctx {
    fn drop(&mut self) {
        drop(self.take());
    }
}

const RESERVE: u32 = 0;
const DISPATCH: u32 = 1;

/// Called by the JS host through the function table (see the top of the file).
/// RESERVE: make the scratch buffer `len` bytes long (contents unspecified), return its address.
/// DISPATCH: the first `len` scratch bytes are a bridge request; replace them with the reply and
/// return its length.
extern "C" fn host_call(ctx: *mut Ctx, op: u32, len: u32) -> u32 {
    let ctx = unsafe { &mut *ctx };
    let mut v = ctx.take();
    match op {
        RESERVE => {
            v.clear();
            v.resize(len as usize, 0);
            ctx.put(v);
            ctx.ptr
        }
        DISPATCH => {
            v.truncate(len as usize);
            let call: extern "C" fn(*mut (), Buffer) -> Buffer = unsafe { std::mem::transmute(ctx.call as usize) };
            let reply = call(ctx.env as usize as *mut (), Buffer::from_vec(v));
            let out = reply.bytes().to_vec();
            reply.free();
            ctx.put(out);
            ctx.len
        }
        _ => {
            ctx.put(v);
            u32::MAX
        }
    }
}

#[link(wasm_import_module = "rust_pm")]
unsafe extern "C" {
    /// Load the proc-macro module at `path` (in the VFS). Returns its number of macros (the
    /// length of its decls slice) and sets `ctx.version`; or -1, with an error message in the
    /// scratch buffer.
    fn load(path: *const u8, path_len: usize, symbol: *const u8, symbol_len: usize, ctx: *mut Ctx) -> i32;
    /// Run macro `index` of the module at `path` (`ctx.version`) on the input in the scratch
    /// buffer, using `ctx` for its bridge requests. 0: the output (an encoded bridge result) is in
    /// the scratch buffer; else an error message is.
    fn expand(path: *const u8, path_len: usize, index: u32, force_show_panics: u32, ctx: *mut Ctx) -> i32;
}

struct Slot {
    path: String,
    version: u32,
    index: u32,
}

static SLOTS: Mutex<Vec<Slot>> = Mutex::new(Vec::new());
/// (path, version) → its table, so a module loaded again (every rustc session loads it anew)
/// keeps its slots.
static TABLES: Mutex<Option<HashMap<(String, u32), &'static [Client]>>> = Mutex::new(None);

include!("pm_slots.rs");

/// `Client::run` of slot N.
extern "C" fn slot<const N: usize>(config: BridgeConfig) -> Buffer {
    let (path, version, index) = {
        let slots = SLOTS.lock().unwrap();
        let s = &slots[N];
        (s.path.clone(), s.version, s.index)
    };
    let BridgeConfig { input, dispatch, force_show_panics } = config;
    let mut ctx = Ctx::new(version, Some(&dispatch));
    ctx.put(input.bytes().to_vec());
    input.free();
    let r = unsafe { expand(path.as_ptr(), path.len(), index, force_show_panics as u32, &mut ctx) };
    let out = ctx.take();
    if r == 0 {
        return Buffer::from_vec(out);
    }
    // The bridge result `Err(PanicMessage::String(..))`: Result tag 1, Option tag 0 (Some), then
    // the string as a usize length (8 bytes, little endian, also on wasm32) and its bytes.
    let msg = format!("the Wasm proc macro {} failed: {}", path, String::from_utf8_lossy(&out));
    let mut enc = vec![1u8, 0];
    enc.extend_from_slice(&(msg.len() as u64).to_le_bytes());
    enc.extend_from_slice(msg.as_bytes());
    Buffer::from_vec(enc)
}

fn loader(path: &Path, symbol: &str) -> Result<&'static [Client], String> {
    let p = path.to_str().ok_or("non-UTF-8 path")?.to_string();
    let mut ctx = Ctx::new(0, None);
    let n = unsafe { load(p.as_ptr(), p.len(), symbol.as_ptr(), symbol.len(), &mut ctx) };
    if n < 0 {
        return Err(format!(": {}", String::from_utf8_lossy(&ctx.take())));
    }
    let key = (p.clone(), ctx.version);
    let mut tables = TABLES.lock().unwrap();
    if let Some(t) = tables.get_or_insert_default().get(&key) {
        return Ok(t);
    }
    let mut slots = SLOTS.lock().unwrap();
    if slots.len() + n as usize > SLOT_FNS.len() {
        return Err(format!(": more than {} Wasm proc macros in one compiler process", SLOT_FNS.len()));
    }
    let clients: Vec<Client> = (0..n as u32)
        .map(|index| {
            let f = SLOT_FNS[slots.len()];
            slots.push(Slot { path: p.clone(), version: ctx.version, index });
            // SAFETY: `Client` is `#[repr(C)] struct Client { run: extern "C" fn(BridgeConfig) -> Buffer }`.
            unsafe { std::mem::transmute::<extern "C" fn(BridgeConfig) -> Buffer, Client>(f) }
        })
        .collect();
    let table: &'static [Client] = Vec::leak(clients);
    tables.as_mut().unwrap().insert(key, table);
    Ok(table)
}

/// Once per process, before the first compile.
pub fn register() {
    let _ = rustc_metadata::register_wasm_proc_macro_loader(loader);
}
