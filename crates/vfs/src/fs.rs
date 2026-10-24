//! The filesystem tree. Plain data structures with no locking: callers serialize access
//! (on wasm, `ffi` holds one lock around every call).
//!
//! Every inode has exactly one parent (no hard links), so its path can always be rebuilt.
//! That keeps change tracking for persistence simple: a set of dirty inodes, plus the paths
//! of everything removed or moved away since the last `take_changes`.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::{String, ToString};
use alloc::vec::Vec;

pub type Ino = u32;
pub const ROOT: Ino = 0;

/// Errors, numbered as WASI preview 1 errnos so the WASI adapter can pass them through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum Error {
    Exist = 20,
    Inval = 28,
    IsDir = 31,
    Loop = 32,
    NameTooLong = 37,
    NoEnt = 44,
    NotDir = 54,
    NotEmpty = 55,
}

pub type Result<T> = core::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Dir = 3,  // WASI filetype directory
    File = 4, // WASI filetype regular_file
}

#[derive(Debug)]
pub enum Node {
    File(Vec<u8>),
    Dir(BTreeMap<String, Ino>),
}

#[derive(Debug)]
pub struct Inode {
    pub node: Node,
    pub parent: Ino,
    pub name: String,
    pub mtime: u64,
    /// Changes under this inode are reported by `take_changes` (it is inside a persisted root).
    pub persist: bool,
}

impl Inode {
    pub fn kind(&self) -> Kind {
        match self.node {
            Node::File(_) => Kind::File,
            Node::Dir(_) => Kind::Dir,
        }
    }
    pub fn size(&self) -> u64 {
        match &self.node {
            Node::File(d) => d.len() as u64,
            Node::Dir(e) => e.len() as u64,
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    /// Paths removed (or moved away) since the last call, in order.
    pub removed: Vec<String>,
    /// Current paths of persisted inodes created or modified since the last call, parents first.
    pub dirty: Vec<(String, Kind)>,
}

pub struct Fs {
    inodes: Vec<Option<Inode>>,
    free: Vec<Ino>,
    dirty: BTreeSet<Ino>,
    removed: Vec<String>,
    /// Bumped on every change to persisted data; the flusher waits on it.
    pub change_seq: u32,
}

const MAX_NAME: usize = 255;

impl Default for Fs {
    fn default() -> Self {
        Self::new()
    }
}

impl Fs {
    pub fn new() -> Self {
        let root = Inode { node: Node::Dir(BTreeMap::new()), parent: ROOT, name: String::new(), mtime: 0, persist: false };
        Fs { inodes: alloc::vec![Some(root)], free: Vec::new(), dirty: BTreeSet::new(), removed: Vec::new(), change_seq: 0 }
    }

    pub fn get(&self, ino: Ino) -> Result<&Inode> {
        self.inodes.get(ino as usize).and_then(Option::as_ref).ok_or(Error::NoEnt)
    }

    fn get_mut(&mut self, ino: Ino) -> Result<&mut Inode> {
        self.inodes.get_mut(ino as usize).and_then(Option::as_mut).ok_or(Error::NoEnt)
    }

    fn entries(&self, dir: Ino) -> Result<&BTreeMap<String, Ino>> {
        match &self.get(dir)?.node {
            Node::Dir(e) => Ok(e),
            Node::File(_) => Err(Error::NotDir),
        }
    }

    fn entries_mut(&mut self, dir: Ino) -> Result<&mut BTreeMap<String, Ino>> {
        match &mut self.get_mut(dir)?.node {
            Node::Dir(e) => Ok(e),
            Node::File(_) => Err(Error::NotDir),
        }
    }

    /// Resolve `path` relative to `dir` (absolute paths start at the root). `.` and `..` are
    /// handled lexically against the tree; `..` at the root stays at the root.
    pub fn lookup(&self, dir: Ino, path: &str) -> Result<Ino> {
        let mut cur = if path.starts_with('/') { ROOT } else { dir };
        self.get(cur)?;
        for comp in path.split('/') {
            match comp {
                "" | "." => {}
                ".." => cur = self.get(cur)?.parent,
                name => cur = *self.entries(cur)?.get(name).ok_or(Error::NoEnt)?,
            }
        }
        Ok(cur)
    }

    /// Split `path` into (parent directory inode, final name). The name must be a real name.
    pub fn parent_of<'p>(&self, dir: Ino, path: &'p str) -> Result<(Ino, &'p str)> {
        let trimmed = path.trim_end_matches('/');
        let (head, name) = match trimmed.rfind('/') {
            Some(i) => (&trimmed[..i.max(1)], &trimmed[i + 1..]),
            None => ("", trimmed),
        };
        let head = if trimmed.starts_with('/') && head.is_empty() { "/" } else { head };
        if name.is_empty() || name == "." || name == ".." {
            return Err(if trimmed.is_empty() && path.starts_with('/') { Error::Exist } else { Error::Inval });
        }
        if name.len() > MAX_NAME {
            return Err(Error::NameTooLong);
        }
        let parent = self.lookup(dir, head)?;
        self.entries(parent)?;
        Ok((parent, name))
    }

    fn alloc(&mut self, inode: Inode) -> Ino {
        match self.free.pop() {
            Some(ino) => {
                self.inodes[ino as usize] = Some(inode);
                ino
            }
            None => {
                self.inodes.push(Some(inode));
                (self.inodes.len() - 1) as Ino
            }
        }
    }

    fn touch(&mut self, ino: Ino, now: u64) {
        if let Ok(i) = self.get_mut(ino) {
            i.mtime = now;
            if i.persist {
                self.dirty.insert(ino);
                self.change_seq = self.change_seq.wrapping_add(1);
            }
        }
    }

    fn insert(&mut self, parent: Ino, name: &str, node: Node, now: u64) -> Result<Ino> {
        if self.entries(parent)?.contains_key(name) {
            return Err(Error::Exist);
        }
        let persist = self.get(parent)?.persist;
        let ino = self.alloc(Inode { node, parent, name: name.to_string(), mtime: now, persist });
        self.entries_mut(parent)?.insert(name.to_string(), ino);
        self.touch(parent, now);
        self.touch(ino, now);
        Ok(ino)
    }

    /// Open-or-create a regular file (`O_CREAT`), optionally exclusive (`O_EXCL`) and truncating.
    pub fn create_file(&mut self, dir: Ino, path: &str, excl: bool, trunc: bool, now: u64) -> Result<Ino> {
        let (parent, name) = self.parent_of(dir, path)?;
        match self.entries(parent)?.get(name).copied() {
            Some(_) if excl => Err(Error::Exist),
            Some(ino) => {
                if self.get(ino)?.kind() == Kind::Dir {
                    return Err(Error::IsDir);
                }
                if trunc {
                    self.truncate(ino, 0, now)?;
                }
                Ok(ino)
            }
            None => self.insert(parent, name, Node::File(Vec::new()), now),
        }
    }

    pub fn mkdir(&mut self, dir: Ino, path: &str, now: u64) -> Result<Ino> {
        let (parent, name) = self.parent_of(dir, path)?;
        self.insert(parent, name, Node::Dir(BTreeMap::new()), now)
    }

    /// `mkdir -p`: create every missing directory along `path`.
    pub fn mkdir_all(&mut self, dir: Ino, path: &str, now: u64) -> Result<Ino> {
        let mut cur = if path.starts_with('/') { ROOT } else { dir };
        for comp in path.split('/').filter(|c| !c.is_empty() && *c != ".") {
            cur = match self.lookup(cur, comp) {
                Ok(ino) => {
                    self.entries(ino)?;
                    ino
                }
                Err(Error::NoEnt) => self.insert(cur, comp, Node::Dir(BTreeMap::new()), now)?,
                Err(e) => return Err(e),
            };
        }
        Ok(cur)
    }

    fn path_of(&self, mut ino: Ino) -> String {
        let mut parts = Vec::new();
        while ino != ROOT {
            let Ok(i) = self.get(ino) else { break };
            parts.push(i.name.as_str());
            ino = i.parent;
        }
        let mut s = String::new();
        for p in parts.iter().rev() {
            s.push('/');
            s.push_str(p);
        }
        if s.is_empty() {
            s.push('/');
        }
        s
    }

    /// Detach `name` from `parent`, recording its path for persistence.
    fn detach(&mut self, parent: Ino, name: &str, now: u64) -> Result<Ino> {
        let ino = *self.entries(parent)?.get(name).ok_or(Error::NoEnt)?;
        if self.get(ino)?.persist {
            let path = self.path_of(ino);
            self.removed.push(path);
            self.change_seq = self.change_seq.wrapping_add(1);
        }
        self.entries_mut(parent)?.remove(name);
        self.touch(parent, now);
        Ok(ino)
    }

    fn release(&mut self, ino: Ino) {
        if let Some(Some(i)) = self.inodes.get_mut(ino as usize).map(Option::take) {
            if let Node::Dir(entries) = i.node {
                for child in entries.into_values() {
                    self.release(child);
                }
            }
            self.dirty.remove(&ino);
            self.free.push(ino);
        }
    }

    pub fn unlink(&mut self, dir: Ino, path: &str, now: u64) -> Result<()> {
        let (parent, name) = self.parent_of(dir, path)?;
        let ino = self.lookup(parent, name)?;
        if self.get(ino)?.kind() == Kind::Dir {
            return Err(Error::IsDir);
        }
        self.detach(parent, name, now)?;
        self.release(ino);
        Ok(())
    }

    pub fn rmdir(&mut self, dir: Ino, path: &str, now: u64) -> Result<()> {
        let (parent, name) = self.parent_of(dir, path)?;
        let ino = self.lookup(parent, name)?;
        if !self.entries(ino)?.is_empty() {
            return Err(Error::NotEmpty);
        }
        self.detach(parent, name, now)?;
        self.release(ino);
        Ok(())
    }

    /// Remove a file or a whole directory tree (`rm -r`).
    pub fn remove_all(&mut self, dir: Ino, path: &str, now: u64) -> Result<()> {
        let (parent, name) = self.parent_of(dir, path)?;
        let ino = self.detach(parent, name, now)?;
        self.release(ino);
        Ok(())
    }

    /// POSIX rename: replaces an existing file, or an existing empty directory.
    pub fn rename(&mut self, from_dir: Ino, from: &str, to_dir: Ino, to: &str, now: u64) -> Result<()> {
        let (fp, fname) = self.parent_of(from_dir, from)?;
        let (tp, tname) = self.parent_of(to_dir, to)?;
        let ino = self.lookup(fp, fname)?;
        let kind = self.get(ino)?.kind();
        if fp == tp && fname == tname {
            return Ok(());
        }
        // Moving a directory into itself.
        if kind == Kind::Dir {
            let mut p = tp;
            loop {
                if p == ino {
                    return Err(Error::Inval);
                }
                if p == ROOT {
                    break;
                }
                p = self.get(p)?.parent;
            }
        }
        if let Some(&existing) = self.entries(tp)?.get(tname) {
            match (kind, self.get(existing)?.kind()) {
                (Kind::File, Kind::Dir) => return Err(Error::IsDir),
                (Kind::Dir, Kind::File) => return Err(Error::NotDir),
                (Kind::Dir, Kind::Dir) if !self.entries(existing)?.is_empty() => return Err(Error::NotEmpty),
                _ => {}
            }
            self.detach(tp, tname, now)?;
            self.release(existing);
        }
        self.detach(fp, fname, now)?;
        let persist = self.get(tp)?.persist;
        {
            let i = self.get_mut(ino)?;
            i.parent = tp;
            i.name = tname.to_string();
        }
        self.entries_mut(tp)?.insert(tname.to_string(), ino);
        self.touch(tp, now);
        self.set_persist_tree(ino, persist);
        Ok(())
    }

    /// Mark a subtree as persisted (or not). Everything in it becomes dirty, so it is written out.
    pub fn set_persist_tree(&mut self, ino: Ino, persist: bool) {
        let children: Vec<Ino> = match self.get(ino).map(|i| &i.node) {
            Ok(Node::Dir(e)) => e.values().copied().collect(),
            _ => Vec::new(),
        };
        if let Ok(i) = self.get_mut(ino) {
            i.persist = persist;
            if persist {
                self.dirty.insert(ino);
                self.change_seq = self.change_seq.wrapping_add(1);
            } else {
                self.dirty.remove(&ino);
            }
        }
        for c in children {
            self.set_persist_tree(c, persist);
        }
    }

    pub fn data(&self, ino: Ino) -> Result<&[u8]> {
        match &self.get(ino)?.node {
            Node::File(d) => Ok(d),
            Node::Dir(_) => Err(Error::IsDir),
        }
    }

    pub fn read_at(&self, ino: Ino, offset: u64, buf: &mut [u8]) -> Result<usize> {
        let data = self.data(ino)?;
        let start = (offset as usize).min(data.len());
        let n = buf.len().min(data.len() - start);
        buf[..n].copy_from_slice(&data[start..start + n]);
        Ok(n)
    }

    /// Make room for `len` bytes at `offset` (zero-filling any gap) and return that slice, so the
    /// caller can copy into it directly (on wasm: straight from another module's memory).
    pub fn reserve(&mut self, ino: Ino, offset: u64, len: usize, now: u64) -> Result<&mut [u8]> {
        self.touch(ino, now);
        let Node::File(data) = &mut self.get_mut(ino)?.node else { return Err(Error::IsDir) };
        let start = offset as usize;
        let end = start.checked_add(len).ok_or(Error::Inval)?;
        if data.len() < end {
            data.resize(end, 0);
        }
        Ok(&mut data[start..end])
    }

    pub fn write_at(&mut self, ino: Ino, offset: u64, bytes: &[u8], now: u64) -> Result<usize> {
        self.reserve(ino, offset, bytes.len(), now)?.copy_from_slice(bytes);
        Ok(bytes.len())
    }

    pub fn truncate(&mut self, ino: Ino, size: u64, now: u64) -> Result<()> {
        self.touch(ino, now);
        let Node::File(data) = &mut self.get_mut(ino)?.node else { return Err(Error::IsDir) };
        data.resize(size as usize, 0);
        if size == 0 {
            data.shrink_to_fit();
        }
        Ok(())
    }

    /// Entry `index` of a directory in name order: (name, inode, kind). `None` past the end.
    pub fn readdir(&self, dir: Ino, index: usize) -> Result<Option<(&str, Ino, Kind)>> {
        let Some((name, &ino)) = self.entries(dir)?.iter().nth(index) else { return Ok(None) };
        Ok(Some((name.as_str(), ino, self.get(ino)?.kind())))
    }

    /// Drain the changes to persisted subtrees since the last call.
    pub fn take_changes(&mut self) -> Changes {
        let removed = core::mem::take(&mut self.removed);
        let mut dirty: Vec<(String, Kind)> = core::mem::take(&mut self.dirty)
            .into_iter()
            .filter_map(|ino| self.get(ino).ok().filter(|i| i.persist).map(|i| (ino, i.kind())))
            .map(|(ino, kind)| (self.path_of(ino), kind))
            .collect();
        // Parents before children (a path sorts before its descendants).
        dirty.sort_by(|a, b| a.0.cmp(&b.0));
        Changes { removed, dirty }
    }

    pub fn inode_count(&self) -> usize {
        self.inodes.len() - self.free.len()
    }
}
