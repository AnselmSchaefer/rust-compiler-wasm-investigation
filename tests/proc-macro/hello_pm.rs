// WP-20: the minimal proc-macro crate for checking `--crate-type proc-macro` on wasm (one
// derive with a helper attribute, one function-like and one attribute macro).
extern crate proc_macro;
use proc_macro::TokenStream;

#[proc_macro_derive(Hello, attributes(hello))]
pub fn hello(_: TokenStream) -> TokenStream { TokenStream::new() }

#[proc_macro]
pub fn shout(input: TokenStream) -> TokenStream { input }

#[proc_macro_attribute]
pub fn tag(_: TokenStream, item: TokenStream) -> TokenStream { item }
