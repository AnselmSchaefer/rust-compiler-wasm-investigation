You have tools of a Rust IDE that runs in a browser (an MCP server called rust-ide). Use only those tools: you have no shell and no local files.

Task:
1. Create a project named `wp38-agent` (overwrite it if it exists) with these two files and a Cargo.toml for a package `wp38-agent` (edition 2021):

`src/lib.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// "x, y" → a point.
pub fn parse(s: &str) -> Point {
    let v: Vec<i32> = s.split(',').map(|p| p.trim().parse().unwrap()).collect();
    Point { x: v[0], y: "oops" }
}

pub fn dist2(p: &Point) -> i32 { return p.x * p.x + p.y * p.y; }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses() {
        assert_eq!(parse("1, 2"), Point { x: 1, y: 2 });
    }

    #[test]
    fn distance() {
        assert_eq!(dist2(&Point { x: 3, y: 4 }), 24);
    }
}
```

`src/main.rs`:
```rust
fn main() {
    let p = wp38_agent::parse("3, 4");
    println!("{:?} has dist2 {}", p, wp38_agent::dist2(&p));
}
```

2. The code uses serde's derive macros: add `serde` (version 1, feature `derive`) as a dependency.
3. Make it compile: there is a compile error; fix it based on the compiler's diagnostics.
4. Run the tests. One test fails; work out whether the test or the code is wrong (the function computes the squared distance) and make all tests pass.
5. Make `cargo_clippy` report no warnings, and format the code with `cargo_fmt` so that `cargo_fmt` with check reports nothing.
6. Run the program with `cargo_run` and report what it printed.

Finish with a short summary of what you changed and the final results of check, test, clippy and fmt.
