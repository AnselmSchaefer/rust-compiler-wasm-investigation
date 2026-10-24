//! A Cargo-compatible resolver for the browser IDE (WP-15): root Cargo.toml + sparse index →
//! the same Cargo.lock that `cargo generate-lockfile` writes. See `docs/resolver.md`.

pub mod index;
pub mod lockfile;
pub mod manifest;
pub mod resolve;
pub mod summary;
#[cfg(target_family = "wasm")]
pub mod wasm;

pub use index::{DirRegistry, Registry};
pub use lockfile::write_lockfile;
pub use manifest::parse_manifest;
pub use resolve::{Resolve, resolve};

/// Cargo.toml text + registry → Cargo.lock text.
pub fn generate_lockfile(manifest: &str, registry: &dyn Registry) -> Result<String, String> {
    let root = parse_manifest(manifest)?;
    Ok(write_lockfile(&resolve(root, registry)?))
}
