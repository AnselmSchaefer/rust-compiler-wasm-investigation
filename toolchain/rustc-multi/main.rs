// Several rustc invocations in one Wasm instance (WP-07): `rustc-multi <args> --next <args> ...`.
// Each group of args runs like `rustc <args>`, through the same catch_with_exit_code that
// rustc_driver::main uses, and prints `rustc-multi: exit <code>` to stderr when it ends. Exits with
// the last group's code. Built out of tree against rustc_driver (like clippy-driver) by
// toolchain/build-rustc-multi.sh; the compile server of WP-09 replaces it.
#![feature(rustc_private)]

extern crate rustc_driver;
extern crate rustc_session;

use std::process::ExitCode;

use rustc_session::EarlyDiagCtxt;
use rustc_session::config::ErrorOutputType;

rustc_driver::override_c_allocator_in_binary!();

struct Callbacks;
impl rustc_driver::Callbacks for Callbacks {}

fn main() -> ExitCode {
    let early_dcx = EarlyDiagCtxt::new(ErrorOutputType::default());
    rustc_driver::init_rustc_env_logger(&early_dcx);
    rustc_driver::install_ice_hook(rustc_driver::DEFAULT_BUG_REPORT_URL, |_| ());

    let args = rustc_driver::args::raw_args(&early_dcx);
    let mut last = ExitCode::SUCCESS;
    for group in args[1..].split(|a| a == "--next") {
        // run_compiler expects argv[0] first.
        let argv: Vec<String> = std::iter::once(args[0].clone()).chain(group.iter().cloned()).collect();
        // catch_with_exit_code turns fatal errors into exit 1 but re-raises other panics, i.e. ICEs
        // (whose report the ICE hook has already printed); rustc would exit with 101 there.
        let r = std::panic::catch_unwind(|| {
            rustc_driver::catch_with_exit_code(|| rustc_driver::run_compiler(&argv, &mut Callbacks))
        });
        // ExitCode has no accessor; SUCCESS is the only code we need to tell apart.
        let code = match r {
            Ok(c) if c == ExitCode::SUCCESS => 0,
            Ok(_) => 1,
            Err(_) => 101,
        };
        last = ExitCode::from(code);
        eprintln!("rustc-multi: exit {code}");
    }
    last
}
