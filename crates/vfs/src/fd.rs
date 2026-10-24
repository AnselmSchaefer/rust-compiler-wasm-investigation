//! Per-process file descriptor tables, kept in the shared memory next to the tree, so every
//! thread of a WASI process (each in its own worker) sees the same fds and seek positions.
//!
//! stdio is not special: the host opens files (e.g. /tmp/proc-1/stdout) as fds 0–2.

use alloc::string::String;
use alloc::vec::Vec;

use crate::fs::{Error, Ino, Result};

pub type Pid = u32;

#[derive(Debug, Clone)]
pub struct Fd {
    pub ino: Ino,
    pub pos: u64,
    pub append: bool,
    /// Guest-visible name of a preopened directory (`fd_prestat_dir_name`).
    pub preopen: Option<String>,
}

#[derive(Default)]
pub struct Procs {
    tables: Vec<Option<Vec<Option<Fd>>>>,
}

impl Procs {
    pub fn new_proc(&mut self) -> Pid {
        if let Some(i) = self.tables.iter().position(Option::is_none) {
            self.tables[i] = Some(Vec::new());
            return i as Pid;
        }
        self.tables.push(Some(Vec::new()));
        (self.tables.len() - 1) as Pid
    }

    pub fn free_proc(&mut self, pid: Pid) {
        if let Some(t) = self.tables.get_mut(pid as usize) {
            *t = None;
        }
    }

    fn table(&mut self, pid: Pid) -> Result<&mut Vec<Option<Fd>>> {
        self.tables.get_mut(pid as usize).and_then(Option::as_mut).ok_or(Error::BadF)
    }

    /// Lowest free fd, as POSIX does.
    pub fn open(&mut self, pid: Pid, fd: Fd) -> Result<u32> {
        let t = self.table(pid)?;
        match t.iter().position(Option::is_none) {
            Some(i) => {
                t[i] = Some(fd);
                Ok(i as u32)
            }
            None => {
                t.push(Some(fd));
                Ok((t.len() - 1) as u32)
            }
        }
    }

    pub fn get(&mut self, pid: Pid, fd: u32) -> Result<&mut Fd> {
        self.table(pid)?.get_mut(fd as usize).and_then(Option::as_mut).ok_or(Error::BadF)
    }

    pub fn close(&mut self, pid: Pid, fd: u32) -> Result<()> {
        let slot = self.table(pid)?.get_mut(fd as usize).ok_or(Error::BadF)?;
        slot.take().map(|_| ()).ok_or(Error::BadF)
    }

    /// `fd_renumber`: move `from` onto `to`, closing whatever `to` was.
    pub fn renumber(&mut self, pid: Pid, from: u32, to: u32) -> Result<()> {
        let t = self.table(pid)?;
        let f = t.get_mut(from as usize).and_then(Option::take).ok_or(Error::BadF)?;
        if t.len() <= to as usize {
            t.resize(to as usize + 1, None);
        }
        t[to as usize] = Some(f);
        Ok(())
    }
}
