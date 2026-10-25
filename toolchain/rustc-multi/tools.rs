// Clippy and rustfmt inside rustc-multi (WP-26), built from the crates that
// toolchain/build-rustc-tools.sh builds for the wasm host. They share rustc-multi's compiler crates,
// so the browser needs no second ~140 MB module.
//
// Clippy: a rustc run with the callbacks of Clippy's own driver (src/tools/clippy/src/driver.rs):
// Clippy's lints and its configuration (clippy.toml, found from CARGO_MANIFEST_DIR or
// CLIPPY_CONF_DIR), its pre-interned symbols, unoptimized MIR (its MIR lints need it) and no
// flattening of format_args!. Plus `--cfg clippy`, as the driver adds.
//
// rustfmt: formats one source text, rustfmt.toml looked up from the working directory, as
// `rustfmt --emit stdout` does with stdin. Arguments: `--edition E`, `--check` (a diff instead of
// the formatted text; exit 1 if the input isn't formatted), `--config K=V,...`.

use std::path::Path;
use std::str::FromStr;

use rustc_interface::interface;
use rustfmt_nightly::{CliOptions, Config, Edition, EmitMode, Input, Session, StyleEdition, Verbosity, Version, load_config};

/// Clippy's part of rustc-multi's `Callbacks::config`.
pub fn clippy_config(config: &mut interface::Config) {
    let previous = config.register_lints.take();
    config.register_lints = Some(Box::new(move |sess, lint_store| {
        if let Some(previous) = &previous {
            (previous)(sess, lint_store);
        }
        let mut list = declare_clippy_lint::LintListBuilder::default();
        list.insert(clippy_lints::declared_lints::LINTS);
        list.register(lint_store);
        let conf = clippy_config::Conf::load(sess);
        clippy_lints::register_lint_passes(lint_store, conf);
    }));
    config.extra_symbols = clippy_utils::sym::EXTRA_SYMBOLS.into();
    config.opts.unstable_opts.mir_opt_level = Some(0);
    config.opts.unstable_opts.mir_enable_passes = vec![("CheckNull".to_owned(), false), ("CheckAlignment".to_owned(), false)];
    config.opts.unstable_opts.flatten_format_args = false;
}

/// The arguments Clippy adds to a rustc run.
pub fn clippy_args(argv: &mut Vec<String>) {
    argv.extend(["--cfg".into(), "clippy".into()]);
}

struct Opts {
    edition: Option<Edition>,
    check: bool,
    inline: Vec<(String, String)>,
}

impl CliOptions for Opts {
    fn apply_to(self, config: &mut Config) {
        config.set().verbose(Verbosity::Quiet);
        if let Some(e) = self.edition {
            config.set_cli().edition(e);
        }
        config.set_cli().emit_mode(if self.check { EmitMode::Diff } else { EmitMode::Stdout });
        for (k, v) in self.inline {
            config.override_value(&k, &v);
        }
    }
    fn config_path(&self) -> Option<&Path> {
        None
    }
    fn edition(&self) -> Option<Edition> {
        self.edition
    }
    fn style_edition(&self) -> Option<StyleEdition> {
        None
    }
    fn version(&self) -> Option<Version> {
        None
    }
}

/// Formats `input`; returns (exit code, output, diagnostics).
pub fn rustfmt(args: &[String], input: String) -> (u8, Vec<u8>, String) {
    let mut opts = Opts { edition: None, check: false, inline: Vec::new() };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--edition" => opts.edition = it.next().and_then(|e| Edition::from_str(e).ok()),
            "--check" => opts.check = true,
            "--config" => {
                for kv in it.next().map(String::as_str).unwrap_or_default().split(',') {
                    if let Some((k, v)) = kv.split_once('=') {
                        opts.inline.push((k.into(), v.into()));
                    }
                }
            }
            a if a.starts_with("--edition=") => opts.edition = Edition::from_str(&a[10..]).ok(),
            other => return (1, Vec::new(), format!("rustfmt: unsupported argument `{other}`\n")),
        }
    }
    let check = opts.check;
    let config = match load_config(Some(Path::new(".")), Some(opts)) {
        Ok((c, _)) => c,
        Err(e) => return (1, Vec::new(), format!("rustfmt: {e}\n")),
    };
    let mut out = Vec::new();
    let mut session = Session::new(config, Some(&mut out));
    let report = session.format(Input::Text(input));
    let mut err = String::new();
    let code = match report {
        Err(e) => {
            err.push_str(&format!("rustfmt: {e}\n"));
            1
        }
        Ok(r) => {
            if r.has_warnings() {
                err.push_str(&format!("{r}"));
            }
            if session.has_operational_errors() || session.has_parsing_errors() {
                1
            } else if check && session.has_diff() {
                1
            } else {
                0
            }
        }
    };
    drop(session);
    (code, out, err)
}
