//! Virtual filesystem for the browser IDE (WP-11).
//!
//! `fs` is the tree itself and builds anywhere (native unit tests). On wasm32, `ffi` exposes it
//! to JS: all workers instantiate the module on one shared memory and see the same files.
#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

pub mod fs;

#[cfg(target_arch = "wasm32")]
mod ffi;

#[cfg(test)]
mod tests;
