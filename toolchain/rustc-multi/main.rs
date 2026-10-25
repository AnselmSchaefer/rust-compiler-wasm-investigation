// Several rustc invocations in one Wasm instance (WP-07, WP-09). Two modes:
//
//   rustc-multi <args>                        exactly like `rustc <args>`
//   rustc-multi <args> --next <args> ...      each group runs like `rustc <args>`; prints
//                                             `rustc-multi: exit <code>` to stderr after each
//   rustc-multi --server [--follow]           compile server: one JSON request per line on stdin,
//                                             {"id": 1, "args": [...], "env": {...}} or
//                                             {"id": 2, "quit": true}; answers
//                                             {"id": 1, "exit": 0, "ms": 12.5} on stdout
//
// In server mode, a line "\x1e<id>" on stderr ends each request's diagnostics, so a host can split
// both streams per request. --follow: stdin is a file that the host appends to (the browser VFS),
// so at its end, wait for more instead of stopping. "env" (optional) sets environment variables
// for that request only, e.g. OUT_DIR and CARGO_PKG_* for env!() (the build planner, WP-17).
//
// Each invocation goes through the same catch_with_exit_code that rustc_driver::main uses, plus a
// catch_unwind for ICEs, which catch_with_exit_code re-raises. Built out of tree against
// rustc_driver (like clippy-driver) by toolchain/build-rustc-multi.sh.
#![feature(rustc_private)]

extern crate rustc_driver;
extern crate rustc_session;
extern crate serde_json;

use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use rustc_session::EarlyDiagCtxt;
use rustc_session::config::ErrorOutputType;
use serde_json::{Value, json};

rustc_driver::override_c_allocator_in_binary!();

struct Callbacks;
impl rustc_driver::Callbacks for Callbacks {}

/// Runs one rustc invocation; `argv[0]` is the program name. Returns 0, 1 (errors) or 101 (ICE).
fn compile(argv: &[String]) -> u8 {
    let r = std::panic::catch_unwind(|| {
        rustc_driver::catch_with_exit_code(|| rustc_driver::run_compiler(argv, &mut Callbacks))
    });
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
        let t0 = Instant::now();
        let code = compile(&argv);
        restore_env(saved);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        eprintln!("\x1e{id}");
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{}", json!({ "id": id, "exit": code, "ms": (ms * 10.0).round() / 10.0 }));
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

    let args = rustc_driver::args::raw_args(&early_dcx);
    if args.get(1).map(String::as_str) == Some("--server") {
        return serve(&args[0], args.get(2).map(String::as_str) == Some("--follow"));
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
