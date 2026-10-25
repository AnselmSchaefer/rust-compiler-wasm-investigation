// Several rustc invocations in one Wasm instance (WP-07, WP-09). Two modes:
//
//   rustc-multi <args>                        exactly like `rustc <args>`
//   rustc-multi <args> --next <args> ...      each group runs like `rustc <args>`; prints
//                                             `rustc-multi: exit <code>` to stderr after each
//   rustc-multi --clippy <args>               `clippy-driver <args>` (tools.rs, WP-26)
//   rustc-multi --rustfmt <args> < source     `rustfmt --emit stdout <args>` on stdin (tools.rs)
//   rustc-multi --server [--follow]           compile server: one JSON request per line on stdin,
//                                             {"id": 1, "args": [...], "env": {...}, "cwd": "/dir",
//                                             "stdin": "..."} or
//                                             {"id": 2, "quit": true}; answers
//                                             {"id": 1, "exit": 0, "ms": 12.5} on stdout
//
// In server mode, a line "\x1e<id>" on stderr ends each request's diagnostics, so a host can split
// both streams per request. --follow: stdin is a file that the host appends to (the browser VFS),
// so at its end, wait for more instead of stopping. "env" (optional) sets environment variables
// for that request only, e.g. OUT_DIR and CARGO_PKG_* for env!() (the build planner, WP-17).
// "cwd" and "stdin" (optional, WP-21) are a build script's `rustc` probe: its working directory,
// and the source it pipes in for an input of `-` (the server's own stdin carries the requests).
// "tool" (optional, WP-26): "clippy" runs the args as Clippy; "rustfmt" formats "stdin" and puts
// the result in the answer's "out" (formatted code can't share stdout with the answer lines).
//
// Each invocation goes through the same catch_with_exit_code that rustc_driver::main uses, plus a
// catch_unwind for ICEs, which catch_with_exit_code re-raises. Built out of tree against
// rustc_driver (like clippy-driver) by toolchain/build-rustc-multi.sh.
//
// Wasm proc macros (WP-20): every invocation runs with `-Zwasm-proc-macros` turned on, and the
// loader in pm.rs is registered, so proc-macro crates built for wasm32-wasip1 load through the
// JS host (web/wasi/proc-macro.ts). With `--cfg rust_pm_stub` (the wasmtime build of
// build-rustc-multi.sh) pm.rs is left out: no `rust_pm` imports, which wasmtime's CLI can't
// provide to spawned threads, and proc macros can't be loaded.
#![feature(rustc_private, proc_macro_internals)]
#![allow(internal_features)]

extern crate rustc_driver;
// Clippy's and rustfmt's crates (toolchain/build-rustc-tools.sh).
extern crate clippy_config;
extern crate clippy_lints;
extern crate clippy_utils;
extern crate declare_clippy_lint;
extern crate rustfmt_nightly;
extern crate rustc_interface;
extern crate rustc_metadata;
extern crate rustc_proc_macro;
extern crate rustc_session;
extern crate rustc_span;
extern crate serde_json;

#[cfg(not(rust_pm_stub))]
mod pm;
mod tools;

use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use rustc_session::EarlyDiagCtxt;
use rustc_session::config::{ErrorOutputType, Input};
use rustc_span::FileName;
use serde_json::{Value, json};

rustc_driver::override_c_allocator_in_binary!();

/// Stands in for an input of `-` when a request brings its own stdin: rustc would read the
/// server's stdin before any callback runs.
const STDIN_INPUT: &str = "/\u{1}rustc-multi-stdin";

struct Callbacks {
    stdin: Option<String>,
    /// Entered once the session options are built: rustc looks for `lib/rustlib` relative to
    /// the working directory when it finds its sysroot (there's no dll_path on WASI).
    cwd: Option<String>,
    clippy: bool,
}
impl rustc_driver::Callbacks for Callbacks {
    fn config(&mut self, config: &mut rustc_interface::Config) {
        // Proc macros are wasm32-wasip1 modules here (pm.rs); no `-Z` flag or RUSTC_BOOTSTRAP needed.
        config.opts.unstable_opts.wasm_proc_macros = true;
        if self.clippy {
            tools::clippy_config(config);
        }
        if let Some(d) = &self.cwd {
            if let Err(e) = std::env::set_current_dir(d) {
                eprintln!("rustc-multi: cwd {d}: {e}");
            }
        }
        if let (Input::File(p), Some(src)) = (&config.input, &self.stdin) {
            if p.as_os_str() == STDIN_INPUT {
                // What rustc's make_input builds from real stdin.
                config.input = Input::Str { name: FileName::anon_source_code(src), input: src.clone() };
            }
        }
    }
}

/// Runs one rustc invocation; `argv[0]` is the program name. Returns 0, 1 (errors) or 101 (ICE).
fn compile(argv: &[String]) -> u8 {
    compile_with(argv, Callbacks { stdin: None, cwd: None, clippy: false })
}

/// With a request's stdin (the source for an input of `-`) and working directory.
fn compile_with(argv: &[String], mut callbacks: Callbacks) -> u8 {
    let mut argv = argv.to_vec();
    if callbacks.clippy {
        tools::clippy_args(&mut argv);
    }
    if callbacks.stdin.is_some() {
        if let Some(i) = argv.iter().rposition(|a| a == "-") {
            argv[i] = STDIN_INPUT.into();
        }
    }
    // An ICE leaves nothing in the callbacks that a later request would read.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        rustc_driver::catch_with_exit_code(|| rustc_driver::run_compiler(&argv, &mut callbacks))
    }));
    // ExitCode has no accessor; SUCCESS is the only code we need to tell apart.
    match r {
        Ok(c) if c == ExitCode::SUCCESS => 0,
        Ok(_) => 1,
        Err(_) => 101,
    }
}

fn serve(argv0: &str, follow: bool) -> ExitCode {
    let stdin = std::io::stdin();
    let mut stdin = stdin.lock();
    let mut line = String::new();
    loop {
        // read_line appends, so a line the host has only partly written yet is completed later.
        match stdin.read_line(&mut line) {
            Ok(0) if follow => {
                std::thread::sleep(Duration::from_millis(1));
                continue;
            }
            Ok(0) => return ExitCode::SUCCESS,
            Ok(_) if !line.ends_with('\n') => continue,
            Ok(_) => {}
            Err(e) => {
                eprintln!("rustc-multi: reading stdin: {e}");
                return ExitCode::FAILURE;
            }
        }
        let request = std::mem::take(&mut line);
        if request.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&request) {
            Ok(v) => v,
            Err(e) => {
                println!("{}", json!({ "error": format!("bad request: {e}") }));
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        if req.get("quit").and_then(Value::as_bool) == Some(true) {
            println!("{}", json!({ "id": id, "quit": true }));
            return ExitCode::SUCCESS;
        }
        let Some(args) = req.get("args").and_then(Value::as_array) else {
            println!("{}", json!({ "id": id, "error": "no args" }));
            continue;
        };
        let argv: Vec<String> = std::iter::once(argv0.to_owned())
            .chain(args.iter().map(|a| a.as_str().unwrap_or_default().to_owned()))
            .collect();
        let env = req.get("env").and_then(Value::as_object);
        let saved = env.map(|e| set_env(e)).unwrap_or_default();
        let cwd = req.get("cwd").and_then(Value::as_str).map(String::from);
        let stdin = req.get("stdin").and_then(Value::as_str).map(String::from);
        let tool = req.get("tool").and_then(Value::as_str).unwrap_or("rustc");
        let home = std::env::current_dir().ok();
        let t0 = Instant::now();
        let mut formatted = None;
        let code = match tool {
            "rustfmt" => {
                if let Some(d) = &cwd {
                    let _ = std::env::set_current_dir(d);
                }
                let (code, out, err) = tools::rustfmt(&argv[1..], stdin.unwrap_or_default());
                eprint!("{err}");
                formatted = Some(String::from_utf8_lossy(&out).into_owned());
                code
            }
            "clippy" => compile_with(&argv, Callbacks { stdin, cwd, clippy: true }),
            _ => compile_with(&argv, Callbacks { stdin, cwd, clippy: false }),
        };
        if let Some(h) = home {
            let _ = std::env::set_current_dir(h);
        }
        restore_env(saved);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        eprintln!("\x1e{id}");
        let mut out = std::io::stdout().lock();
        let mut answer = json!({ "id": id, "exit": code, "ms": (ms * 10.0).round() / 10.0 });
        if let Some(f) = formatted {
            answer["out"] = Value::String(f);
        }
        let _ = writeln!(out, "{answer}");
        let _ = out.flush();
    }
}

type SavedEnv = Vec<(String, Option<std::ffi::OsString>)>;

fn set_env(env: &serde_json::Map<String, Value>) -> SavedEnv {
    env.iter()
        .map(|(k, v)| {
            let old = std::env::var_os(k);
            // SAFETY: requests run one at a time; no compiler thread is alive between them.
            unsafe { std::env::set_var(k, v.as_str().unwrap_or_default()) };
            (k.clone(), old)
        })
        .collect()
}

fn restore_env(saved: SavedEnv) {
    for (k, old) in saved.into_iter().rev() {
        // SAFETY: as in set_env.
        match old {
            Some(v) => unsafe { std::env::set_var(&k, v) },
            None => unsafe { std::env::remove_var(&k) },
        }
    }
}

fn main() -> ExitCode {
    let early_dcx = EarlyDiagCtxt::new(ErrorOutputType::default());
    rustc_driver::init_rustc_env_logger(&early_dcx);
    rustc_driver::install_ice_hook(rustc_driver::DEFAULT_BUG_REPORT_URL, |_| ());
    #[cfg(not(rust_pm_stub))]
    pm::register();

    let args = rustc_driver::args::raw_args(&early_dcx);
    if args.get(1).map(String::as_str) == Some("--server") {
        return serve(&args[0], args.get(2).map(String::as_str) == Some("--follow"));
    }
    if args.get(1).map(String::as_str) == Some("--clippy") {
        let argv: Vec<String> = std::iter::once(args[0].clone()).chain(args[2..].iter().cloned()).collect();
        return ExitCode::from(compile_with(&argv, Callbacks { stdin: None, cwd: None, clippy: true }));
    }
    if args.get(1).map(String::as_str) == Some("--rustfmt") {
        let mut input = String::new();
        if let Err(e) = std::io::Read::read_to_string(&mut std::io::stdin(), &mut input) {
            eprintln!("rustfmt: reading stdin: {e}");
            return ExitCode::FAILURE;
        }
        let (code, out, err) = tools::rustfmt(&args[2..], input);
        let _ = std::io::stdout().write_all(&out);
        eprint!("{err}");
        return ExitCode::from(code);
    }
    // Without --next it is a plain rustc: same output, same exit code (what release.sh ships).
    if !args.iter().any(|a| a == "--next") {
        return ExitCode::from(compile(&args));
    }
    let mut last = 0;
    for group in args[1..].split(|a| a == "--next") {
        // run_compiler expects argv[0] first.
        let argv: Vec<String> = std::iter::once(args[0].clone()).chain(group.iter().cloned()).collect();
        last = compile(&argv);
        eprintln!("rustc-multi: exit {last}");
    }
    ExitCode::from(last)
}
