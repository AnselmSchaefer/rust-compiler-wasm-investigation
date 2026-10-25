//! A "raw" Wasm proc macro (WP-20 experiment): the module rustc would emit for a proc-macro
//! crate on wasm, without pm_guest. It exports only the harness's decls static
//! (`__rustc_proc_macro_decls_*`: a `&[Client]`), `_initialize` (crt1-reactor.o), its function
//! table, `malloc`/`free`/`realloc` and memory. The host drives the stock `proc_macro` client
//! directly: it builds a `BridgeConfig` in guest memory and calls `Client.run` through the
//! table; its own `reserve`/`drop` (for buffers it allocates) and the `dispatch` closure are
//! host functions it adds to the table.
//!
//! wasm32 C ABI (checked on the module): structs go by pointer, a struct result through a
//! return pointer. `run(sret, &BridgeConfig)`, `reserve(sret, &Buffer, usize)`, `drop(&Buffer)`,
//! `dispatch.call(sret, env, &Buffer)`. Layout (32-bit): Buffer = data, len, capacity, reserve,
//! drop (20 bytes); Closure = call, env (8); BridgeConfig = Buffer, Closure, bool (32).

use std::path::Path;

use wasmtime::{Caller, Engine, Func, Instance, Linker, Memory, Module, Ref, Store, Table, TypedFunc, Val};
use wasmtime_wasi::p1::{self, WasiP1Ctx};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::WasiCtxBuilder;

use crate::{Callback, Dispatch, MacroDecl};

#[derive(Clone)]
struct Exports {
    memory: Memory,
    table: Table,
    malloc: TypedFunc<u32, u32>,
    free: TypedFunc<u32, ()>,
    realloc: TypedFunc<(u32, u32), u32>,
    /// Table indices of the host's reserve, drop and dispatch functions.
    reserve: u32,
    drop: u32,
    call: u32,
}

pub(crate) struct State {
    wasi: WasiP1Ctx,
    exports: Option<Exports>,
    dispatch: Option<Callback>,
    dispatches: u64,
}

pub struct RawGuest {
    store: Store<State>,
    clients: Vec<u32>,
    stderr: MemoryOutputPipe,
    pub macros: Vec<MacroDecl>,
}

fn u32_at(m: &Memory, s: impl wasmtime::AsContext, at: u32) -> u32 {
    u32::from_le_bytes(m.data(&s)[at as usize..at as usize + 4].try_into().unwrap())
}

/// A Buffer: (data, len, capacity, reserve, drop).
fn read_buffer(m: &Memory, s: impl wasmtime::AsContext, at: u32) -> [u32; 5] {
    std::array::from_fn(|i| u32_at(m, &s, at + 4 * i as u32))
}

fn write_words(m: &Memory, s: impl wasmtime::AsContextMut, at: u32, words: &[u32]) -> wasmtime::Result<()> {
    let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
    m.write(s, at as usize, &bytes)?;
    Ok(())
}

fn table_fn<P: wasmtime::WasmParams, R: wasmtime::WasmResults>(e: &Exports, mut s: impl wasmtime::AsContextMut, idx: u32) -> wasmtime::Result<TypedFunc<P, R>> {
    let f = e.table.get(&mut s, idx as u64).and_then(|r| r.as_func().flatten().copied()).ok_or_else(|| wasmtime::Error::msg(format!("no function at table index {idx}")))?;
    f.typed(&s)
}

impl RawGuest {
    pub fn is_raw(module: &Module) -> bool {
        module.exports().any(|e| e.name().starts_with("__rustc_proc_macro_decls_"))
    }

    pub fn load(engine: &Engine, module: &Module, path: &Path) -> wasmtime::Result<RawGuest> {
        let mut linker: Linker<State> = Linker::new(engine);
        p1::add_to_linker_sync(&mut linker, |s: &mut State| &mut s.wasi)?;
        let stderr = MemoryOutputPipe::new(1 << 20);
        let wasi = WasiCtxBuilder::new().stderr(stderr.clone()).build_p1();
        let mut store = Store::new(engine, State { wasi, exports: None, dispatch: None, dispatches: 0 });
        let instance: Instance = linker.instantiate(&mut store, module)?;
        instance.get_typed_func::<(), ()>(&mut store, "_initialize")?.call(&mut store, ())?;
        let memory = instance.get_memory(&mut store, "memory").ok_or_else(|| wasmtime::Error::msg("no memory export"))?;
        let table = instance.get_table(&mut store, "__indirect_function_table").ok_or_else(|| wasmtime::Error::msg("no table export (link with --export-table)"))?;
        let decls_name = module.exports().map(|e| e.name().to_string()).find(|n| n.starts_with("__rustc_proc_macro_decls_")).unwrap();
        let addr = match instance.get_global(&mut store, &decls_name).map(|g| g.get(&mut store)) {
            Some(Val::I32(a)) => a as u32,
            _ => return Err(wasmtime::Error::msg("the decls export is not an i32 global")),
        };
        // The static holds a `&[Client]`: (pointer, length); each Client is a table index.
        let (ptr, len) = (u32_at(&memory, &store, addr), u32_at(&memory, &store, addr + 4));
        let clients: Vec<u32> = (0..len).map(|i| u32_at(&memory, &store, ptr + 4 * i)).collect();

        let reserve = Func::wrap(&mut store, |mut c: Caller<'_, State>, sret: u32, buf: u32, additional: u32| -> wasmtime::Result<()> {
            let e = c.data().exports.clone().unwrap();
            let [data, len, cap, r, d] = read_buffer(&e.memory, &c, buf);
            let new_cap = (cap * 2).max(len + additional);
            let p = e.realloc.call(&mut c, (data, new_cap))?;
            write_words(&e.memory, &mut c, sret, &[p, len, new_cap, r, d])
        });
        let drop = Func::wrap(&mut store, |mut c: Caller<'_, State>, buf: u32| -> wasmtime::Result<()> {
            let e = c.data().exports.clone().unwrap();
            let data = u32_at(&e.memory, &c, buf);
            e.free.call(&mut c, data)
        });
        let call = Func::wrap(&mut store, |mut c: Caller<'_, State>, sret: u32, _env: u32, buf: u32| -> wasmtime::Result<()> {
            let e = c.data().exports.clone().unwrap();
            let [data, len, cap, r, d] = read_buffer(&e.memory, &c, buf);
            let f = c.data().dispatch.expect("dispatch outside of expand");
            c.data_mut().dispatches += 1;
            let request = e.memory.data(&c)[data as usize..(data + len) as usize].to_vec();
            let mut result = Ok(());
            unsafe {
                (*f.0)(&request, &mut |reply| {
                    result = (|| -> wasmtime::Result<()> {
                        let n = reply.len() as u32;
                        if n <= cap {
                            // The reply goes into the request's buffer, as the bridge's own server does.
                            e.memory.write(&mut c, data as usize, reply)?;
                            write_words(&e.memory, &mut c, sret, &[data, n, cap, r, d])
                        } else {
                            // Grow it with its own `reserve` (the client's or ours).
                            write_words(&e.memory, &mut c, buf + 4, &[0])?;
                            table_fn::<(u32, u32, u32), ()>(&e, &mut c, r)?.call(&mut c, (sret, buf, n))?;
                            let p = u32_at(&e.memory, &c, sret);
                            e.memory.write(&mut c, p as usize, reply)?;
                            write_words(&e.memory, &mut c, sret + 4, &[n])
                        }
                    })();
                })
            };
            result
        });
        let base = table.grow(&mut store, 3, Ref::Func(None))? as u32;
        for (i, f) in [reserve, drop, call].into_iter().enumerate() {
            table.set(&mut store, (base + i as u32) as u64, Ref::Func(Some(f)))?;
        }
        store.data_mut().exports = Some(Exports {
            memory,
            table,
            malloc: instance.get_typed_func(&mut store, "malloc")?,
            free: instance.get_typed_func(&mut store, "free")?,
            realloc: instance.get_typed_func(&mut store, "realloc")?,
            reserve: base,
            drop: base + 1,
            call: base + 2,
        });
        // The macros' names and kinds come from rustc's metadata in the real thing; here, from
        // pm-rewrite's list next to the module.
        let macros: Vec<MacroDecl> = serde_json::from_slice(&std::fs::read(path.with_extension("macros.json"))?)?;
        if macros.len() != clients.len() {
            return Err(wasmtime::Error::msg(format!("{} macros listed, {} clients", macros.len(), clients.len())));
        }
        Ok(RawGuest { store, clients, stderr, macros })
    }

    pub fn expand(&mut self, index: u32, input: &[u8], force_show_panics: bool, dispatch: &mut Dispatch<'_>) -> Result<Vec<u8>, String> {
        self.run(index, input, force_show_panics, dispatch).map_err(|e| {
            let stderr = String::from_utf8_lossy(&self.stderr.contents()).into_owned();
            format!("the Wasm proc macro trapped: {e}\n{stderr}")
        })
    }

    fn run(&mut self, index: u32, input: &[u8], force_show_panics: bool, dispatch: &mut Dispatch<'_>) -> wasmtime::Result<Vec<u8>> {
        let e = self.store.data().exports.clone().unwrap();
        let s = &mut self.store;
        let n = input.len() as u32;
        let data = e.malloc.call(&mut *s, n.max(1))?;
        e.memory.write(&mut *s, data as usize, input)?;
        // BridgeConfig { input: Buffer, dispatch: Closure { call, env }, force_show_panics } and
        // the result's return area.
        let cfg = e.malloc.call(&mut *s, 32 + 20)?;
        let sret = cfg + 32;
        write_words(&e.memory, &mut *s, cfg, &[data, n, n.max(1), e.reserve, e.drop, e.call, 0, force_show_panics as u32])?;
        let d: *mut Dispatch<'_> = dispatch;
        s.data_mut().dispatch = Some(Callback(unsafe { std::mem::transmute::<*mut Dispatch<'_>, *mut Dispatch<'static>>(d) }));
        let r = table_fn::<(u32, u32), ()>(&e, &mut *s, self.clients[index as usize]).and_then(|run| run.call(&mut *s, (sret, cfg)));
        s.data_mut().dispatch = None;
        r?;
        let [out, len, _, _, drop_fn] = read_buffer(&e.memory, &*s, sret);
        let bytes = e.memory.data(&*s)[out as usize..(out + len) as usize].to_vec();
        table_fn::<u32, ()>(&e, &mut *s, drop_fn)?.call(&mut *s, sret)?;
        e.free.call(&mut *s, cfg)?;
        Ok(bytes)
    }

    pub fn dispatches(&self) -> u64 {
        self.store.data().dispatches
    }
}
