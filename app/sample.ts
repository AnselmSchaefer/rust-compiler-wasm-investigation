// The IDE's guided sample project (WP-40): one small crate that touches every feature. serde
// derive (a crates.io dependency with a proc macro), a build script, a program reading stdin, a
// failing test, a Clippy lint and unformatted code. README.md walks through it.

export const SAMPLE_NAME = 'sample';

export const SAMPLE: Record<string, string> = {
  'README.md': `# The sample project

A tour of the browser IDE. Everything runs in this tab: rustc (compiled to WebAssembly), the
crates.io resolver, build scripts, proc macros, tests, Clippy and rustfmt.

1. **Build** (or Run). The first build fetches serde from crates.io and compiles it, with
   serde_derive as a WebAssembly proc macro and a build script. Watch the progress line and
   the stats row. Later builds take the dependencies from the cache.
2. **Run**. The program asks for points in the terminal. Type \`3, 4\` and press Enter, then
   Ctrl-D to finish.
3. **Test**. One test fails. Open it in the Tests tab: its panic message says why. The
   function computes the *squared* distance, so the test expects the wrong number. Fix the
   test in \`src/lib.rs\`, then use **Rerun** on just that test.
4. **Clippy**. It finds a needless \`return\`. Click the problem to jump to it, and fix it.
5. **Format**. rustfmt formats the files. Then **Check**: no problems left.
6. **+ Dependency** adds a crate, as \`cargo add\` does. Try \`itoa\`.

An agent can do the same through the relay (tools/relay, MCP): its calls show up in the
Activity tab, and the files it changes in the tree and the editor.
`,
  'Cargo.toml': `[package]
name = "sample"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
`,
  'build.rs': `// A build script: runs before the crate compiles, here only to set an environment variable.
fn main() {
    println!("cargo:rustc-env=SAMPLE_BUILT_BY=build.rs");
}
`,
  'src/lib.rs': `use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// "x, y" -> a point.
pub fn parse(s: &str) -> Option<Point> {
    let mut it = s.split(',').map(|p| p.trim().parse::<i32>());
    match (it.next(), it.next(), it.next()) {
        (Some(Ok(x)), Some(Ok(y)), None) => Some(Point { x, y }),
        _ => None,
    }
}

/// The squared distance from the origin.
pub fn dist2(p: &Point) -> i32 { return p.x * p.x + p.y * p.y; }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses() {
        assert_eq!(parse("1, 2"), Some(Point { x: 1, y: 2 }));
        assert_eq!(parse("1, x"), None);
    }

    #[test]
    fn distance() {
        assert_eq!(dist2(&Point { x: 3, y: 4 }), 5);
    }
}
`,
  'src/main.rs': `use std::io::{self, BufRead, Write};

fn main() {
    println!("Points, one per line as \\"x, y\\" (built by {}). Ctrl-D ends.", env!("SAMPLE_BUILT_BY"));
    let mut stdout = io::stdout();
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        match sample::parse(&line) {
            Some(p) => println!("{p:?}: dist2 = {}", sample::dist2(&p)),
            None => println!("not a point: {line:?}"),
        }
        stdout.flush().unwrap();
    }
    println!("bye");
}
`,
};
