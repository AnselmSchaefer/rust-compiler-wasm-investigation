//! The `std` that build scripts, and the host-side crates they use, are compiled against (WP-21).
//!
//! WASI preview 1 has no processes, so the real `std::process::Command` always fails. This crate is
//! passed as `--extern std=…` (it is named `std`): it re-exports the real std and replaces only
//! `process`. Its `Command` sends the program, arguments, environment, working directory and stdin
//! to the host (`rust_bs.run`), which runs `rustc` on a compile server and answers with the exit
//! code and output; any other program is "not found". A child runs when its result is first
//! needed (wait, output, reading its stdout), so stdin written to it beforehand is complete, as with
//! autocfg's `rustc -` probes.
//!
//! It also enters `CARGO_MANIFEST_DIR` before `main`, because cargo runs build scripts in their
//! package directory and WASI has no way to start a program elsewhere. And it gives `stat` and
//! friends permission bits (the build script links with `--wrap=stat` etc.): wasi-libc's `st_mode`
//! has only the file type, so every file looks read-only, and autocfg refuses such an OUT_DIR.
//!
//! Wire format (little-endian): request = program, cwd, stdin, then u32 count + args, then u32
//! count + `KEY=VALUE` env entries, each a u32 length + bytes. Response = i32 status (-1: not
//! found), stdout, stderr.
#![no_std]

extern crate std as real;

pub use real::*;

#[link(wasm_import_module = "rust_bs")]
unsafe extern "C" {
    /// Runs a request; returns the response's length (kept by the host until `take`).
    fn run(req: *const u8, len: usize) -> usize;
    /// Copies the last response to `buf`.
    fn take(buf: *mut u8);
}

#[used]
#[unsafe(link_section = ".init_array")]
static ENTER_PACKAGE_DIR: extern "C" fn() = enter_package_dir;

extern "C" fn enter_package_dir() {
    if let Some(d) = real::env::var_os("CARGO_MANIFEST_DIR") {
        let _ = real::env::set_current_dir(d);
    }
}

/// Referenced by the build script's link (`-u`), so that the archive member with the
/// constructor above and the wrappers below is linked in (this crate is one codegen unit).
#[unsafe(no_mangle)]
pub static __bs_std_init: u8 = 0;

unsafe extern "C" {
    fn __real_stat(path: *const u8, buf: *mut u8) -> i32;
    fn __real_lstat(path: *const u8, buf: *mut u8) -> i32;
    fn __real_fstat(fd: i32, buf: *mut u8) -> i32;
    fn __real_fstatat(fd: i32, path: *const u8, buf: *mut u8, flag: i32) -> i32;
}

/// rwxr-xr-x for directories, rw-r--r-- for the rest. `st_mode` is the u32 at offset 24 of
/// wasi-libc's `struct stat` on wasm32 (after st_dev, st_ino and st_nlink, u64 each).
unsafe fn with_permissions(r: i32, buf: *mut u8) -> i32 {
    if r == 0 {
        // SAFETY: the call succeeded, so `buf` is a filled-in struct stat.
        unsafe {
            let mode = buf.add(24).cast::<u32>();
            let bits = if *mode & 0o170000 == 0o040000 { 0o755 } else { 0o644 };
            mode.write_unaligned(mode.read_unaligned() | bits);
        }
    }
    r
}

#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_stat(path: *const u8, buf: *mut u8) -> i32 {
    unsafe { with_permissions(__real_stat(path, buf), buf) }
}
#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_lstat(path: *const u8, buf: *mut u8) -> i32 {
    unsafe { with_permissions(__real_lstat(path, buf), buf) }
}
#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_fstat(fd: i32, buf: *mut u8) -> i32 {
    unsafe { with_permissions(__real_fstat(fd, buf), buf) }
}
#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap_fstatat(fd: i32, path: *const u8, buf: *mut u8, flag: i32) -> i32 {
    unsafe { with_permissions(__real_fstatat(fd, path, buf, flag), buf) }
}

pub mod process {
    use real::ffi::{OsStr, OsString};
    use real::fmt;
    use real::fs::File;
    use real::io::{self, Read, Write};
    use real::path::{Path, PathBuf};
    use real::string::{String, ToString};
    use real::sync::{Arc, Mutex};
    use real::vec::Vec;

    pub use real::process::{ExitCode, Termination, abort, exit, id};

    /// What a child's stdin, stdout or stderr is connected to.
    pub struct Stdio(Io);

    enum Io {
        Inherit,
        Piped,
        Null,
        File(File),
        /// Another child's output, as this one's stdin.
        Bytes(Vec<u8>),
    }

    impl Stdio {
        pub fn piped() -> Stdio {
            Stdio(Io::Piped)
        }
        pub fn inherit() -> Stdio {
            Stdio(Io::Inherit)
        }
        pub fn null() -> Stdio {
            Stdio(Io::Null)
        }
        pub fn makes_pipe(&self) -> bool {
            matches!(self.0, Io::Piped)
        }
    }

    impl fmt::Debug for Stdio {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(match self.0 {
                Io::Inherit => "Inherit",
                Io::Piped => "MakePipe",
                Io::Null => "Null",
                Io::File(_) => "File",
                Io::Bytes(_) => "Bytes",
            })
        }
    }

    impl From<File> for Stdio {
        fn from(f: File) -> Stdio {
            Stdio(Io::File(f))
        }
    }
    impl From<io::Stdout> for Stdio {
        fn from(_: io::Stdout) -> Stdio {
            Stdio(Io::Inherit)
        }
    }
    impl From<io::Stderr> for Stdio {
        fn from(_: io::Stderr) -> Stdio {
            Stdio(Io::Inherit)
        }
    }
    impl From<ChildStdout> for Stdio {
        fn from(mut c: ChildStdout) -> Stdio {
            let mut b = Vec::new();
            let _ = c.read_to_end(&mut b);
            Stdio(Io::Bytes(b))
        }
    }
    impl From<ChildStderr> for Stdio {
        fn from(mut c: ChildStderr) -> Stdio {
            let mut b = Vec::new();
            let _ = c.read_to_end(&mut b);
            Stdio(Io::Bytes(b))
        }
    }

    pub struct Command {
        program: OsString,
        args: Vec<OsString>,
        /// Changes to the inherited environment, in order (None: removed).
        env: Vec<(OsString, Option<OsString>)>,
        env_clear: bool,
        cwd: Option<PathBuf>,
        stdin: Option<Stdio>,
        stdout: Option<Stdio>,
        stderr: Option<Stdio>,
    }

    impl Command {
        pub fn new<S: AsRef<OsStr>>(program: S) -> Command {
            Command {
                program: program.as_ref().into(),
                args: Vec::new(),
                env: Vec::new(),
                env_clear: false,
                cwd: None,
                stdin: None,
                stdout: None,
                stderr: None,
            }
        }
        pub fn arg<S: AsRef<OsStr>>(&mut self, arg: S) -> &mut Command {
            self.args.push(arg.as_ref().into());
            self
        }
        pub fn args<I: IntoIterator<Item = S>, S: AsRef<OsStr>>(&mut self, args: I) -> &mut Command {
            for a in args {
                self.arg(a);
            }
            self
        }
        pub fn env<K: AsRef<OsStr>, V: AsRef<OsStr>>(&mut self, key: K, val: V) -> &mut Command {
            self.env.push((key.as_ref().into(), Some(val.as_ref().into())));
            self
        }
        pub fn envs<I: IntoIterator<Item = (K, V)>, K: AsRef<OsStr>, V: AsRef<OsStr>>(&mut self, vars: I) -> &mut Command {
            for (k, v) in vars {
                self.env(k, v);
            }
            self
        }
        pub fn env_remove<K: AsRef<OsStr>>(&mut self, key: K) -> &mut Command {
            self.env.push((key.as_ref().into(), None));
            self
        }
        pub fn env_clear(&mut self) -> &mut Command {
            self.env.clear();
            self.env_clear = true;
            self
        }
        pub fn current_dir<P: AsRef<Path>>(&mut self, dir: P) -> &mut Command {
            self.cwd = Some(dir.as_ref().into());
            self
        }
        pub fn stdin<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Command {
            self.stdin = Some(cfg.into());
            self
        }
        pub fn stdout<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Command {
            self.stdout = Some(cfg.into());
            self
        }
        pub fn stderr<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Command {
            self.stderr = Some(cfg.into());
            self
        }
        pub fn get_program(&self) -> &OsStr {
            &self.program
        }
        pub fn get_args(&self) -> CommandArgs<'_> {
            CommandArgs { iter: self.args.iter() }
        }
        pub fn get_envs(&self) -> CommandEnvs<'_> {
            CommandEnvs { iter: self.env.iter() }
        }
        pub fn get_current_dir(&self) -> Option<&Path> {
            self.cwd.as_deref()
        }

        /// Starts the child; stdin, stdout and stderr are inherited unless set.
        pub fn spawn(&mut self) -> io::Result<Child> {
            self.start(Io::Inherit, false)
        }
        /// stdout and stderr captured, stdin empty unless set.
        pub fn output(&mut self) -> io::Result<Output> {
            let child = self.start(Io::Piped, true)?;
            child.wait_with_output()
        }
        pub fn status(&mut self) -> io::Result<ExitStatus> {
            self.start(Io::Inherit, true)?.wait()
        }

        fn start(&mut self, default: Io, null_stdin: bool) -> io::Result<Child> {
            let take = |s: &mut Option<Stdio>, d: Io| s.take().map(|s| s.0).unwrap_or(d);
            let dflt = || match default {
                Io::Piped => Io::Piped,
                _ => Io::Inherit,
            };
            let stdin = take(&mut self.stdin, if null_stdin { Io::Null } else { dflt() });
            let (stdout, stderr) = (take(&mut self.stdout, dflt()), take(&mut self.stderr, dflt()));
            let mut input = Vec::new();
            let piped_in = matches!(stdin, Io::Piped);
            match stdin {
                Io::File(mut f) => {
                    f.read_to_end(&mut input)?;
                }
                Io::Bytes(b) => input = b,
                Io::Inherit => {
                    real::io::stdin().read_to_end(&mut input)?;
                }
                Io::Piped | Io::Null => {}
            }
            let req = self.request()?;
            let state = Arc::new(Mutex::new(State { req, input, result: None }));
            let mut child = Child { state: state.clone(), stdin: None, stdout: None, stderr: None, out: [stdout, stderr] };
            if piped_in {
                child.stdin = Some(ChildStdin { state: state.clone() });
            } else {
                // Nothing more to wait for: run now, so that a missing program fails here, as
                // spawn would.
                child.state.lock().unwrap().run()?;
            }
            if matches!(child.out[0], Io::Piped) {
                child.stdout = Some(ChildStdout(Pipe { state: state.clone(), fd: 1, pos: 0 }));
            }
            if matches!(child.out[1], Io::Piped) {
                child.stderr = Some(ChildStderr(Pipe { state, fd: 2, pos: 0 }));
            }
            Ok(child)
        }

        /// The request without stdin (added when the child runs).
        fn request(&self) -> io::Result<Request> {
            let mut env: Vec<(OsString, OsString)> = if self.env_clear { Vec::new() } else { real::env::vars_os().collect() };
            for (k, v) in &self.env {
                env.retain(|(ek, _)| ek != k);
                if let Some(v) = v {
                    env.push((k.clone(), v.clone()));
                }
            }
            let here = real::env::current_dir()?;
            let cwd = match &self.cwd {
                Some(d) => here.join(d),
                None => here,
            };
            Ok(Request { program: self.program.clone(), args: self.args.clone(), env, cwd })
        }
    }

    impl fmt::Debug for Command {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "{:?}", self.program)?;
            for a in &self.args {
                write!(f, " {a:?}")?;
            }
            Ok(())
        }
    }

    pub struct CommandArgs<'a> {
        iter: real::slice::Iter<'a, OsString>,
    }
    impl<'a> Iterator for CommandArgs<'a> {
        type Item = &'a OsStr;
        fn next(&mut self) -> Option<&'a OsStr> {
            self.iter.next().map(|a| a.as_os_str())
        }
        fn size_hint(&self) -> (usize, Option<usize>) {
            self.iter.size_hint()
        }
    }
    impl ExactSizeIterator for CommandArgs<'_> {}

    pub struct CommandEnvs<'a> {
        iter: real::slice::Iter<'a, (OsString, Option<OsString>)>,
    }
    impl<'a> Iterator for CommandEnvs<'a> {
        type Item = (&'a OsStr, Option<&'a OsStr>);
        fn next(&mut self) -> Option<Self::Item> {
            self.iter.next().map(|(k, v)| (k.as_os_str(), v.as_deref()))
        }
    }

    struct Request {
        program: OsString,
        args: Vec<OsString>,
        env: Vec<(OsString, OsString)>,
        cwd: PathBuf,
    }

    struct Outcome {
        status: ExitStatus,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    }

    struct State {
        req: Request,
        input: Vec<u8>,
        result: Option<io::Result<Outcome>>,
    }

    impl State {
        /// Runs the child once, with the stdin written so far.
        fn run(&mut self) -> io::Result<&Outcome> {
            if self.result.is_none() {
                self.result = Some(call(&self.req, &self.input));
            }
            match self.result.as_ref().unwrap() {
                Ok(o) => Ok(o),
                Err(e) => Err(io::Error::new(e.kind(), e.to_string())),
            }
        }
    }

    fn call(req: &Request, input: &[u8]) -> io::Result<Outcome> {
        fn put(b: &mut Vec<u8>, s: &[u8]) {
            b.extend_from_slice(&(s.len() as u32).to_le_bytes());
            b.extend_from_slice(s);
        }
        let bytes = |s: &OsStr| s.as_encoded_bytes().to_vec();
        let mut b = Vec::new();
        put(&mut b, &bytes(&req.program));
        put(&mut b, &bytes(req.cwd.as_os_str()));
        put(&mut b, input);
        b.extend_from_slice(&(req.args.len() as u32).to_le_bytes());
        for a in &req.args {
            put(&mut b, &bytes(a));
        }
        b.extend_from_slice(&(req.env.len() as u32).to_le_bytes());
        for (k, v) in &req.env {
            let mut kv = bytes(k);
            kv.push(b'=');
            kv.extend_from_slice(v.as_encoded_bytes());
            put(&mut b, &kv);
        }
        // SAFETY: the host reads `b` and writes exactly the length it returned.
        let resp = unsafe {
            let n = super::run(b.as_ptr(), b.len());
            let mut r = Vec::with_capacity(n);
            super::take(r.as_mut_ptr());
            r.set_len(n);
            r
        };
        let mut at = 0;
        let mut word = || {
            let w = u32::from_le_bytes(resp[at..at + 4].try_into().unwrap());
            at += 4;
            w
        };
        let status = word() as i32;
        let n = word() as usize;
        let stdout = resp[at..at + n].to_vec();
        at += n;
        let n = u32::from_le_bytes(resp[at..at + 4].try_into().unwrap()) as usize;
        let stderr = resp[at + 4..at + 4 + n].to_vec();
        if status == -1 {
            let msg = String::from_utf8_lossy(&stderr).into_owned();
            return Err(io::Error::new(io::ErrorKind::NotFound, msg));
        }
        Ok(Outcome { status: ExitStatus(status), stdout, stderr })
    }

    pub struct Child {
        state: Arc<Mutex<State>>,
        pub stdin: Option<ChildStdin>,
        pub stdout: Option<ChildStdout>,
        pub stderr: Option<ChildStderr>,
        /// Where stdout and stderr go when they aren't piped.
        out: [Io; 2],
    }

    impl Child {
        pub fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }
        pub fn id(&self) -> u32 {
            1
        }
        pub fn wait(&mut self) -> io::Result<ExitStatus> {
            drop(self.stdin.take());
            let mut s = self.state.lock().unwrap();
            let o = s.run()?;
            let status = o.status;
            for (fd, (io, data)) in self.out.iter_mut().zip([&o.stdout, &o.stderr]).enumerate() {
                match io {
                    Io::Inherit if fd == 0 => real::io::stdout().write_all(data)?,
                    Io::Inherit => real::io::stderr().write_all(data)?,
                    Io::File(f) => f.write_all(data)?,
                    _ => {}
                }
                // Written once, however often wait is called.
                *io = Io::Null;
            }
            Ok(status)
        }
        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            self.wait().map(Some)
        }
        pub fn wait_with_output(mut self) -> io::Result<Output> {
            let status = self.wait()?;
            let s = self.state.lock().unwrap();
            let o = s.result.as_ref().unwrap().as_ref().unwrap();
            let rest = |p: &Option<Pipe>, d: &Vec<u8>| p.as_ref().map(|p| d[p.pos.min(d.len())..].to_vec()).unwrap_or_default();
            let stdout = rest(&self.stdout.as_ref().map(|c| c.0.clone_pos()), &o.stdout);
            let stderr = rest(&self.stderr.as_ref().map(|c| c.0.clone_pos()), &o.stderr);
            Ok(Output { status, stdout, stderr })
        }
    }

    impl fmt::Debug for Child {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("Child").field("stdin", &self.stdin).field("stdout", &self.stdout).field("stderr", &self.stderr).finish_non_exhaustive()
        }
    }

    pub struct ChildStdin {
        state: Arc<Mutex<State>>,
    }

    impl Write for ChildStdin {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut s = self.state.lock().unwrap();
            if s.result.is_some() {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            s.input.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Write for &ChildStdin {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut s = self.state.lock().unwrap();
            if s.result.is_some() {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            s.input.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl fmt::Debug for ChildStdin {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("ChildStdin { .. }")
        }
    }

    /// A child's stdout or stderr: reading it runs the child.
    struct Pipe {
        state: Arc<Mutex<State>>,
        fd: u8,
        pos: usize,
    }

    impl Pipe {
        fn clone_pos(&self) -> Pipe {
            Pipe { state: self.state.clone(), fd: self.fd, pos: self.pos }
        }
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut s = self.state.lock().unwrap();
            let o = s.run()?;
            let data = if self.fd == 1 { &o.stdout } else { &o.stderr };
            let n = buf.len().min(data.len().saturating_sub(self.pos));
            buf[..n].copy_from_slice(&data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    pub struct ChildStdout(Pipe);
    pub struct ChildStderr(Pipe);

    impl Read for ChildStdout {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }
    impl Read for ChildStderr {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }
    impl fmt::Debug for ChildStdout {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("ChildStdout { .. }")
        }
    }
    impl fmt::Debug for ChildStderr {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("ChildStderr { .. }")
        }
    }

    #[derive(PartialEq, Eq, Clone)]
    pub struct Output {
        pub status: ExitStatus,
        pub stdout: Vec<u8>,
        pub stderr: Vec<u8>,
    }

    impl fmt::Debug for Output {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            let text = |b: &Vec<u8>| String::from_utf8_lossy(b).into_owned();
            f.debug_struct("Output").field("status", &self.status).field("stdout", &text(&self.stdout)).field("stderr", &text(&self.stderr)).finish()
        }
    }

    #[derive(PartialEq, Eq, Clone, Copy, Debug, Default)]
    pub struct ExitStatus(i32);

    impl ExitStatus {
        pub fn success(&self) -> bool {
            self.0 == 0
        }
        pub fn code(&self) -> Option<i32> {
            Some(self.0)
        }
    }

    impl fmt::Display for ExitStatus {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "exit status: {}", self.0)
        }
    }
}
