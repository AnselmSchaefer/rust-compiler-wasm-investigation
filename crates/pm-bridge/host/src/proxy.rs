//! A `proc_macro::bridge::server::Server` on top of the public `proc_macro` API. Used inside a
//! native proc macro, it lets a Wasm proc macro (the client) talk to the native rustc that runs
//! that proc macro: each bridge request becomes calls of the public API, which go to rustc over
//! its own bridge. Token streams are passed through as they are, so the output tokens are
//! rustc's; only span details that the public API can't express are approximated:
//!
//! - Spans are ids into a table of native spans, without deduplication (the public `Span` has no
//!   `Hash`), so two requests for the same span give different handles.
//! - A group built by the guest gets one span for its delimiters and its whole (`set_span`), as
//!   `Group::set_span` does natively, even for a group the guest received and returns unchanged.
//! - `span_subspan` has no public equivalent (only `Literal::subspan`): `None`.

use std::ops::{Bound, Range};

use proc_macro::bridge::server::Server;
use proc_macro::bridge::{self, DelimSpan, Diagnostic, ExpnGlobals, LitKind};
use proc_macro::{Group, Ident, Level, Literal, Punct, Spacing, Span, TokenStream, TokenTree};

#[derive(Copy, Clone, PartialEq, Eq, Hash)]
pub struct SpanId(u32);

thread_local! {
    /// Time in calls that go to the native compiler (for the overhead split; see lib.rs Stats).
    pub static NATIVE: std::cell::Cell<std::time::Duration> = const { std::cell::Cell::new(std::time::Duration::ZERO) };
}

/// A call that goes to the native compiler over its bridge.
fn native<R>(f: impl FnOnce() -> R) -> R {
    let t = std::time::Instant::now();
    let r = f();
    NATIVE.set(NATIVE.get() + t.elapsed());
    r
}

type Symbol = Box<str>;
type BTokenTree = bridge::TokenTree<TokenStream, SpanId, Symbol>;
type BLiteral = bridge::Literal<SpanId, Symbol>;

#[derive(Default)]
pub struct Proxy {
    spans: Vec<Span>,
}

impl Proxy {
    pub fn new() -> Proxy {
        Proxy::default()
    }

    fn id(&mut self, s: Span) -> SpanId {
        self.spans.push(s);
        SpanId(self.spans.len() as u32 - 1)
    }

    fn span(&self, id: SpanId) -> Span {
        self.spans[id.0 as usize]
    }

    fn to_native(&self, tree: BTokenTree) -> TokenTree {
        match tree {
            bridge::TokenTree::Group(g) => {
                let mut n = Group::new(g.delimiter, g.stream.unwrap_or_default());
                n.set_span(self.span(g.span.entire));
                n.into()
            }
            bridge::TokenTree::Punct(p) => {
                let mut n = Punct::new(p.ch as char, if p.joint { Spacing::Joint } else { Spacing::Alone });
                n.set_span(self.span(p.span));
                n.into()
            }
            bridge::TokenTree::Ident(i) => {
                let span = self.span(i.span);
                if i.is_raw { Ident::new_raw(&i.sym, span) } else { Ident::new(&i.sym, span) }.into()
            }
            bridge::TokenTree::Literal(l) => {
                let mut n = native_literal(&l);
                n.set_span(self.span(l.span));
                n.into()
            }
        }
    }

    fn from_native(&mut self, tree: TokenTree) -> BTokenTree {
        match tree {
            TokenTree::Group(g) => {
                let span = DelimSpan { open: self.id(g.span_open()), close: self.id(g.span_close()), entire: self.id(g.span()) };
                let stream = g.stream();
                bridge::TokenTree::Group(bridge::Group { delimiter: g.delimiter(), stream: (!stream.is_empty()).then_some(stream), span })
            }
            TokenTree::Punct(p) => bridge::TokenTree::Punct(bridge::Punct {
                ch: p.as_char() as u8,
                joint: p.spacing() == Spacing::Joint,
                span: self.id(p.span()),
            }),
            TokenTree::Ident(i) => {
                let s = i.to_string();
                let (sym, is_raw) = match s.strip_prefix("r#") {
                    Some(rest) => (rest.into(), true),
                    None => (s.into(), false),
                };
                bridge::TokenTree::Ident(bridge::Ident { sym, is_raw, span: self.id(i.span()) })
            }
            TokenTree::Literal(l) => {
                let (kind, symbol, suffix) = classify(&l.to_string());
                bridge::TokenTree::Literal(bridge::Literal { kind, symbol, suffix, span: self.id(l.span()) })
            }
        }
    }

    fn diagnostic(&self, d: Diagnostic<SpanId>) -> proc_macro::Diagnostic {
        let spans: Vec<Span> = d.spans.iter().map(|s| self.span(*s)).collect();
        let mut n = if spans.is_empty() { proc_macro::Diagnostic::new(d.level, d.message) } else { proc_macro::Diagnostic::spanned(spans, d.level, d.message) };
        for c in d.children {
            let spans: Vec<Span> = c.spans.iter().map(|s| self.span(*s)).collect();
            n = match (c.level, spans.is_empty()) {
                (Level::Error, true) => n.error(c.message),
                (Level::Warning, true) => n.warning(c.message),
                (Level::Note, true) => n.note(c.message),
                (Level::Help, true) => n.help(c.message),
                (Level::Error, false) => n.span_error(spans, c.message),
                (Level::Warning, false) => n.span_warning(spans, c.message),
                (Level::Note, false) => n.span_note(spans, c.message),
                (Level::Help, false) => n.span_help(spans, c.message),
                _ => n.note(c.message),
            };
        }
        n
    }
}

/// A bridge literal as source text (proc_macro's `Literal::with_stringify_parts`).
fn literal_text(l: &BLiteral) -> String {
    let (s, suffix) = (&*l.symbol, l.suffix.as_deref().unwrap_or(""));
    let h = |n: u8| "#".repeat(n as usize);
    match l.kind {
        LitKind::Byte => format!("b'{s}'{suffix}"),
        LitKind::Char => format!("'{s}'{suffix}"),
        LitKind::Str => format!("\"{s}\"{suffix}"),
        LitKind::StrRaw(n) => format!("r{0}\"{s}\"{0}{suffix}", h(n)),
        LitKind::ByteStr => format!("b\"{s}\"{suffix}"),
        LitKind::ByteStrRaw(n) => format!("br{0}\"{s}\"{0}{suffix}", h(n)),
        LitKind::CStr => format!("c\"{s}\"{suffix}"),
        LitKind::CStrRaw(n) => format!("cr{0}\"{s}\"{0}{suffix}", h(n)),
        LitKind::Integer | LitKind::Float | LitKind::ErrWithGuar => format!("{s}{suffix}"),
    }
}

/// A bridge literal as a native one. `Literal::from_str` is a round trip to the compiler, so the
/// common shapes use the constructors, which build the same symbol locally: a string without
/// escapes (`Literal::string` then escapes nothing) and a canonical decimal integer.
fn native_literal(l: &BLiteral) -> Literal {
    let (sym, suffix) = (&*l.symbol, l.suffix.as_deref());
    match (l.kind, suffix) {
        // Printable ASCII only: `Literal::string` escapes with `Debug`, which also escapes some Unicode.
        (LitKind::Str, None) if sym.bytes().all(|b| (b' '..=b'~').contains(&b) && b != b'\\' && b != b'"') => return Literal::string(sym),
        (LitKind::Integer, _) => {
            if let Ok(v) = sym.parse::<u128>() {
                if v.to_string() == sym {
                    let lit = match suffix {
                        None => Some(Literal::u128_unsuffixed(v)),
                        Some("usize") => usize::try_from(v).ok().map(Literal::usize_suffixed),
                        Some("u8") => u8::try_from(v).ok().map(Literal::u8_suffixed),
                        Some("u16") => u16::try_from(v).ok().map(Literal::u16_suffixed),
                        Some("u32") => u32::try_from(v).ok().map(Literal::u32_suffixed),
                        Some("u64") => u64::try_from(v).ok().map(Literal::u64_suffixed),
                        _ => None,
                    };
                    if let Some(lit) = lit {
                        return lit;
                    }
                }
            }
        }
        _ => {}
    }
    native(|| literal_text(l).parse()).unwrap_or_else(|_| panic!("literal {:?}", literal_text(l)))
}

/// Source text of one literal → (kind, symbol, suffix), as rustc's lexer splits it. A leading
/// `-` (from `Literal::from_str`) stays in the symbol, as in rustc's server.
fn classify(text: &str) -> (LitKind, Symbol, Option<Symbol>) {
    if let Some(rest) = text.strip_prefix('-') {
        let (k, s, x) = classify(rest);
        return (k, format!("-{s}").into(), x);
    }
    let suffix = |rest: &str| (!rest.is_empty()).then(|| rest.into());
    // Quoted: escape-aware scan to the closing quote.
    let quoted = |body: &str, q: char| -> (Symbol, Option<Symbol>) {
        let mut it = body.char_indices();
        while let Some((i, c)) = it.next() {
            if c == '\\' {
                it.next();
            } else if c == q {
                return (body[..i].into(), suffix(&body[i + 1..]));
            }
        }
        panic!("unterminated literal {text:?}")
    };
    // Raw: r#"…"# — the content ends at the last `"` followed by the hashes.
    let raw = |body: &str| -> (u8, Symbol, Option<Symbol>) {
        let n = body.bytes().take_while(|b| *b == b'#').count();
        let close = format!("\"{}", "#".repeat(n));
        let content = &body[n + 1..];
        let end = content.rfind(&close).unwrap_or_else(|| panic!("raw literal {text:?}"));
        (n as u8, content[..end].into(), suffix(&content[end + close.len()..]))
    };
    for (prefix, raw_kind, kind) in [("br", Some(LitKind::ByteStrRaw as fn(u8) -> LitKind), None), ("cr", Some(LitKind::CStrRaw), None), ("r", Some(LitKind::StrRaw), None),
        ("b\"", None, Some(LitKind::ByteStr)), ("c\"", None, Some(LitKind::CStr)), ("b'", None, Some(LitKind::Byte)), ("\"", None, Some(LitKind::Str)), ("'", None, Some(LitKind::Char))]
    {
        let Some(body) = text.strip_prefix(prefix) else { continue };
        if let Some(k) = raw_kind {
            if body.starts_with('"') || body.starts_with('#') {
                let (n, s, x) = raw(body);
                return (k(n), s, x);
            }
            continue;
        }
        let kind = kind.unwrap();
        let (s, x) = quoted(body, if matches!(kind, LitKind::Byte | LitKind::Char) { '\'' } else { '"' });
        return (kind, s, x);
    }
    // A number: digits (and `_`), then for decimals an optional fraction and exponent; the rest
    // is the suffix. A float suffix on an integer (`1f32`) stays an Integer, as in rustc.
    let b = text.as_bytes();
    let mut i;
    let mut float = false;
    if b.len() > 1 && b[0] == b'0' && matches!(b[1], b'x' | b'o' | b'b') {
        i = 2;
        let hex = b[1] == b'x';
        while i < b.len() && (b[i] == b'_' || if hex { b[i].is_ascii_hexdigit() } else { b[i].is_ascii_digit() }) {
            i += 1;
        }
    } else {
        i = 0;
        while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'_') {
            i += 1;
        }
        if i + 1 < b.len() && b[i] == b'.' && b[i + 1].is_ascii_digit() {
            float = true;
            i += 1;
            while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'_') {
                i += 1;
            }
        } else if i + 1 == b.len() && b[i] == b'.' {
            // `1.`
            float = true;
            i += 1;
        }
        if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
            let mut j = i + 1;
            if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
                j += 1;
            }
            if j < b.len() && (b[j].is_ascii_digit() || b[j] == b'_') {
                float = true;
                i = j;
                while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'_') {
                    i += 1;
                }
            }
        }
    }
    (if float { LitKind::Float } else { LitKind::Integer }, text[..i].into(), suffix(&text[i..]))
}

impl Server for Proxy {
    type TokenStream = TokenStream;
    type Span = SpanId;
    type Symbol = Symbol;

    fn globals(&mut self) -> ExpnGlobals<SpanId> {
        ExpnGlobals { def_site: self.id(Span::def_site()), call_site: self.id(Span::call_site()), mixed_site: self.id(Span::mixed_site()) }
    }

    fn intern_symbol(ident: &str) -> Symbol {
        ident.into()
    }

    fn with_symbol_string(symbol: &Symbol, f: impl FnOnce(&str)) {
        f(symbol)
    }

    /// The guest's environment is empty, so env lookups go to the compiler's process.
    fn injected_env_var(&mut self, var: &str) -> Option<String> {
        std::env::var(var).ok()
    }

    fn track_env_var(&mut self, var: &str, _value: Option<&str>) {
        let _ = proc_macro::tracked::env_var(var);
    }

    fn track_path(&mut self, path: &str) {
        proc_macro::tracked::path(path);
    }

    fn literal_from_str(&mut self, s: &str) -> Result<BLiteral, String> {
        let l: Literal = native(|| s.parse()).map_err(|e: proc_macro::LexError| e.to_string())?;
        let (kind, symbol, suffix) = classify(&l.to_string());
        Ok(bridge::Literal { kind, symbol, suffix, span: self.id(Span::call_site()) })
    }

    fn emit_diagnostic(&mut self, d: Diagnostic<SpanId>) {
        self.diagnostic(d).emit();
    }

    fn ts_drop(&mut self, stream: TokenStream) {
        native(|| drop(stream));
    }

    fn ts_clone(&mut self, stream: &TokenStream) -> TokenStream {
        native(|| stream.clone())
    }

    fn ts_is_empty(&mut self, stream: &TokenStream) -> bool {
        native(|| stream.is_empty())
    }

    fn ts_expand_expr(&mut self, stream: &TokenStream) -> Result<TokenStream, ()> {
        native(|| stream.expand_expr()).map_err(|_| ())
    }

    fn ts_from_str(&mut self, src: &str) -> Result<TokenStream, String> {
        native(|| src.parse()).map_err(|e: proc_macro::LexError| e.to_string())
    }

    fn ts_to_string(&mut self, stream: &TokenStream) -> String {
        native(|| stream.to_string())
    }

    fn ts_from_token_tree(&mut self, tree: BTokenTree) -> TokenStream {
        let tree = self.to_native(tree);
        native(|| TokenStream::from(tree))
    }

    fn ts_concat_trees(&mut self, base: Option<TokenStream>, trees: Vec<BTokenTree>) -> TokenStream {
        let trees: Vec<TokenTree> = trees.into_iter().map(|t| self.to_native(t)).collect();
        let mut s = base.unwrap_or_default();
        native(|| s.extend(trees));
        s
    }

    fn ts_concat_streams(&mut self, base: Option<TokenStream>, streams: Vec<TokenStream>) -> TokenStream {
        let mut s = base.unwrap_or_default();
        native(|| s.extend(streams));
        s
    }

    fn ts_into_trees(&mut self, stream: TokenStream) -> Vec<BTokenTree> {
        let trees: Vec<TokenTree> = native(|| stream.into_iter().collect());
        trees.into_iter().map(|t| self.from_native(t)).collect()
    }

    fn span_debug(&mut self, span: SpanId) -> String {
        format!("{:?}", self.span(span))
    }

    fn span_parent(&mut self, span: SpanId) -> Option<SpanId> {
        self.span(span).parent().map(|s| self.id(s))
    }

    fn span_source(&mut self, span: SpanId) -> SpanId {
        let s = self.span(span).source();
        self.id(s)
    }

    fn span_byte_range(&mut self, span: SpanId) -> Range<usize> {
        self.span(span).byte_range()
    }

    fn span_start(&mut self, span: SpanId) -> SpanId {
        let s = self.span(span).start();
        self.id(s)
    }

    fn span_end(&mut self, span: SpanId) -> SpanId {
        let s = self.span(span).end();
        self.id(s)
    }

    fn span_line(&mut self, span: SpanId) -> usize {
        self.span(span).line()
    }

    fn span_column(&mut self, span: SpanId) -> usize {
        self.span(span).column()
    }

    fn span_file(&mut self, span: SpanId) -> String {
        self.span(span).file()
    }

    fn span_local_file(&mut self, span: SpanId) -> Option<String> {
        self.span(span).local_file().map(|p| p.to_string_lossy().into_owned())
    }

    fn span_join(&mut self, span: SpanId, other: SpanId) -> Option<SpanId> {
        self.span(span).join(self.span(other)).map(|s| self.id(s))
    }

    fn span_subspan(&mut self, _span: SpanId, _start: Bound<usize>, _end: Bound<usize>) -> Option<SpanId> {
        None
    }

    fn span_resolved_at(&mut self, span: SpanId, at: SpanId) -> SpanId {
        let s = self.span(span).resolved_at(self.span(at));
        self.id(s)
    }

    fn span_source_text(&mut self, span: SpanId) -> Option<String> {
        self.span(span).source_text()
    }

    fn span_save_span(&mut self, span: SpanId) -> usize {
        self.span(span).save_span()
    }

    fn span_recover_proc_macro_span(&mut self, id: usize) -> SpanId {
        let s = Span::recover_proc_macro_span(id);
        self.id(s)
    }

    fn symbol_normalize_and_validate_ident(&mut self, string: &str) -> Result<Symbol, ()> {
        std::panic::catch_unwind(|| Ident::new(string, Span::call_site()).to_string()).map(Into::into).map_err(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals() {
        let cases: &[(&str, LitKind, &str, Option<&str>)] = &[
            ("1", LitKind::Integer, "1", None),
            ("1u8", LitKind::Integer, "1", Some("u8")),
            ("0xffu8", LitKind::Integer, "0xff", Some("u8")),
            ("0x1f32", LitKind::Integer, "0x1f32", None),
            ("1f32", LitKind::Integer, "1", Some("f32")),
            ("1.5", LitKind::Float, "1.5", None),
            ("1e10", LitKind::Float, "1e10", None),
            ("2.5E-3f64", LitKind::Float, "2.5E-3", Some("f64")),
            ("1.", LitKind::Float, "1.", None),
            ("-7i32", LitKind::Integer, "-7", Some("i32")),
            ("\"a\\\"b\"", LitKind::Str, "a\\\"b", None),
            ("\"x\"suf", LitKind::Str, "x", Some("suf")),
            ("r#\"a\"b\"#", LitKind::StrRaw(1), "a\"b", None),
            ("r\"plain\"", LitKind::StrRaw(0), "plain", None),
            ("b\"bytes\"", LitKind::ByteStr, "bytes", None),
            ("br##\"x\"##", LitKind::ByteStrRaw(2), "x", None),
            ("c\"cs\"", LitKind::CStr, "cs", None),
            ("'\\''", LitKind::Char, "\\'", None),
            ("b'a'", LitKind::Byte, "a", None),
        ];
        for (text, kind, sym, suffix) in cases {
            let (k, s, x) = classify(text);
            assert_eq!((k, &*s, x.as_deref()), (*kind, *sym, *suffix), "{text}");
            assert_eq!(literal_text(&bridge::Literal { kind: k, symbol: s, suffix: x, span: SpanId(0) }), *text);
        }
    }
}
