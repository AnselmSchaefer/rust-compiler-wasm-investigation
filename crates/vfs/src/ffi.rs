//! C ABI for the JS wrapper (web/vfs). Every worker instantiates this module on the *same*
//! shared memory, so they all see one filesystem.
//!
//! Protocol (enforced by the JS side):
//! - Every call is made while holding the lock word at `VFS_LOCK` (a JS `Atomics` lock), so
//!   this code, including the allocator, never runs concurrently.
//! - Before its first call, an instance claims a slot (`Atomics.add` on `VFS_NEXT_SLOT`) and
//!   points its exported `__stack_pointer` at the top of the slot's stack. The rest of the slot
//!   is scratch space for passing paths and results.
//! - Results: `>= 0` is a value (usually an inode), `< 0` is `-errno` (WASI numbering).

use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicU32, Ordering};

use crate::fs::{Error, Fs, Ino, Kind};

// ---------- shared statics, located by JS through their exported addresses ----------

#[unsafe(no_mangle)]
pub static VFS_LOCK: AtomicU32 = AtomicU32::new(0);
/// Mirrors `Fs::change_seq` after every call; the flusher waits on it (JS notifies).
#[unsafe(no_mangle)]
pub static VFS_CHANGE_SEQ: AtomicU32 = AtomicU32::new(0);
#[unsafe(no_mangle)]
pub static VFS_NEXT_SLOT: AtomicU32 = AtomicU32::new(0);

const STACK_SIZE: usize = 64 * 1024;
const SCRATCH_SIZE: usize = 64 * 1024;
const SLOT_SIZE: usize = STACK_SIZE + SCRATCH_SIZE;
const MAX_SLOTS: usize = 128;

#[unsafe(no_mangle)]
pub static VFS_SLOT_LAYOUT: [u32; 3] = [SLOT_SIZE as u32, STACK_SIZE as u32, MAX_SLOTS as u32];

#[repr(C, align(16))]
pub struct Slots(UnsafeCell<[[u8; SLOT_SIZE]; MAX_SLOTS]>);
unsafe impl Sync for Slots {}
#[unsafe(no_mangle)]
pub static VFS_SLOTS: Slots = Slots(UnsafeCell::new([[0; SLOT_SIZE]; MAX_SLOTS]));

struct Global(UnsafeCell<Option<Fs>>);
unsafe impl Sync for Global {}
static FS: Global = Global(UnsafeCell::new(None));

struct Buf(UnsafeCell<alloc::vec::Vec<u8>>);
unsafe impl Sync for Buf {}
static CHANGES: Buf = Buf(UnsafeCell::new(alloc::vec::Vec::new()));

fn fs() -> &'static mut Fs {
    // SAFETY: callers hold VFS_LOCK (see module docs), so there is exactly one live reference.
    unsafe { (*FS.0.get()).get_or_insert_with(Fs::new) }
}

fn sync_seq() {
    VFS_CHANGE_SEQ.store(fs().change_seq, Ordering::SeqCst);
}

fn path<'a>(ptr: *const u8, len: usize) -> Result<&'a str, Error> {
    // SAFETY: JS wrote `len` bytes at `ptr` in this instance's scratch slot.
    core::str::from_utf8(unsafe { core::slice::from_raw_parts(ptr, len) }).map_err(|_| Error::Inval)
}

fn ret(r: Result<Ino, Error>) -> i32 {
    sync_seq();
    match r {
        Ok(v) => v as i32,
        Err(e) => -(e as i32),
    }
}

fn ret_unit(r: Result<(), Error>) -> i32 {
    ret(r.map(|()| 0))
}

// ---------- operations ----------

#[unsafe(no_mangle)]
pub extern "C" fn vfs_lookup(dir: Ino, p: *const u8, len: usize) -> i32 {
    ret(path(p, len).and_then(|p| fs().lookup(dir, p)))
}

/// Open-or-create a file. `flags`: bit 0 exclusive, bit 1 truncate.
#[unsafe(no_mangle)]
pub extern "C" fn vfs_create(dir: Ino, p: *const u8, len: usize, flags: u32, now: u64) -> i32 {
    ret(path(p, len).and_then(|p| fs().create_file(dir, p, flags & 1 != 0, flags & 2 != 0, now)))
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_mkdir(dir: Ino, p: *const u8, len: usize, now: u64) -> i32 {
    ret(path(p, len).and_then(|p| fs().mkdir(dir, p, now)))
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_mkdir_all(dir: Ino, p: *const u8, len: usize, now: u64) -> i32 {
    ret(path(p, len).and_then(|p| fs().mkdir_all(dir, p, now)))
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_unlink(dir: Ino, p: *const u8, len: usize, now: u64) -> i32 {
    ret_unit(path(p, len).and_then(|p| fs().unlink(dir, p, now)))
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_rmdir(dir: Ino, p: *const u8, len: usize, now: u64) -> i32 {
    ret_unit(path(p, len).and_then(|p| fs().rmdir(dir, p, now)))
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_remove_all(dir: Ino, p: *const u8, len: usize, now: u64) -> i32 {
    ret_unit(path(p, len).and_then(|p| fs().remove_all(dir, p, now)))
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_rename(fd: Ino, fp: *const u8, fl: usize, td: Ino, tp: *const u8, tl: usize, now: u64) -> i32 {
    ret_unit(path(fp, fl).and_then(|f| path(tp, tl).and_then(|t| fs().rename(fd, f, td, t, now))))
}

/// Writes `[kind: u32, _: u32, size: u64, mtime: u64]` to `out`.
#[unsafe(no_mangle)]
pub extern "C" fn vfs_stat(ino: Ino, out: *mut u64) -> i32 {
    ret_unit(fs().get(ino).map(|i| unsafe {
        out.write(i.kind() as u64);
        out.add(1).write(i.size());
        out.add(2).write(i.mtime);
    }))
}

/// Writes `[ptr: u32, len: u32]` of the file's bytes to `out`. Valid until the lock is released.
#[unsafe(no_mangle)]
pub extern "C" fn vfs_data(ino: Ino, out: *mut u32) -> i32 {
    ret_unit(fs().data(ino).map(|d| unsafe {
        out.write(d.as_ptr() as u32);
        out.add(1).write(d.len() as u32);
    }))
}

/// Grow the file as needed and return a pointer to `len` writable bytes at `offset` (0 on error).
/// JS copies the data in before releasing the lock.
#[unsafe(no_mangle)]
pub extern "C" fn vfs_reserve(ino: Ino, offset: u64, len: usize, now: u64) -> *mut u8 {
    let r = fs().reserve(ino, offset, len, now).map(|s| s.as_mut_ptr());
    sync_seq();
    r.unwrap_or(core::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_truncate(ino: Ino, size: u64, now: u64) -> i32 {
    ret_unit(fs().truncate(ino, size, now))
}

/// Entry `index` of a directory: writes `[name_ptr, name_len, ino, kind]` (u32 each) to `out`.
/// Returns 1 for an entry, 0 past the end.
#[unsafe(no_mangle)]
pub extern "C" fn vfs_readdir(dir: Ino, index: usize, out: *mut u32) -> i32 {
    ret(fs().readdir(dir, index).map(|e| match e {
        Some((name, ino, kind)) => unsafe {
            out.write(name.as_ptr() as u32);
            out.add(1).write(name.len() as u32);
            out.add(2).write(ino);
            out.add(3).write(kind as u32);
            1
        },
        None => 0,
    }))
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_set_persist(ino: Ino, persist: u32) -> i32 {
    fs().set_persist_tree(ino, persist != 0);
    ret(Ok(0))
}

/// Serialize and clear pending changes. Writes `[ptr, len]` to `out`; the buffer is reused by the
/// next call. Format (little endian): u32 n, n × (u32 len, path); u32 m, m × (u8 kind, u32 len, path).
#[unsafe(no_mangle)]
pub extern "C" fn vfs_take_changes(out: *mut u32) -> i32 {
    let c = fs().take_changes();
    // SAFETY: under the lock, as for FS.
    let buf = unsafe { &mut *CHANGES.0.get() };
    buf.clear();
    buf.extend_from_slice(&(c.removed.len() as u32).to_le_bytes());
    for p in &c.removed {
        buf.extend_from_slice(&(p.len() as u32).to_le_bytes());
        buf.extend_from_slice(p.as_bytes());
    }
    buf.extend_from_slice(&(c.dirty.len() as u32).to_le_bytes());
    for (p, kind) in &c.dirty {
        buf.push(*kind as u8);
        buf.extend_from_slice(&(p.len() as u32).to_le_bytes());
        buf.extend_from_slice(p.as_bytes());
    }
    unsafe {
        out.write(buf.as_ptr() as u32);
        out.add(1).write(buf.len() as u32);
    }
    ret(Ok(0))
}

#[unsafe(no_mangle)]
pub extern "C" fn vfs_inode_count() -> i32 {
    fs().inode_count() as i32
}

const _: () = assert!(Kind::File as u8 == 4);

// ---------- runtime ----------

/// Allocations only happen inside FFI calls, which are serialized by VFS_LOCK.
struct Alloc(UnsafeCell<dlmalloc::Dlmalloc>);
unsafe impl Sync for Alloc {}

unsafe impl core::alloc::GlobalAlloc for Alloc {
    unsafe fn alloc(&self, l: core::alloc::Layout) -> *mut u8 {
        unsafe { (*self.0.get()).malloc(l.size(), l.align()) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: core::alloc::Layout) {
        unsafe { (*self.0.get()).free(p, l.size(), l.align()) }
    }
    unsafe fn alloc_zeroed(&self, l: core::alloc::Layout) -> *mut u8 {
        unsafe { (*self.0.get()).calloc(l.size(), l.align()) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: core::alloc::Layout, new: usize) -> *mut u8 {
        unsafe { (*self.0.get()).realloc(p, l.size(), l.align(), new) }
    }
}

#[global_allocator]
static ALLOC: Alloc = Alloc(UnsafeCell::new(dlmalloc::Dlmalloc::new()));

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
