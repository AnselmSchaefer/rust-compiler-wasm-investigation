use serde_json::{json, Value};

fn main() {
    let v = json!({ "name": "demo", "n": [1, 2.5, -3], "ok": true });
    let s = serde_json::to_string(&v).unwrap();
    println!("{s}");
    let back: Value = serde_json::from_str(&s).unwrap();
    assert_eq!(back, v);
    println!("roundtrip ok, n[1] = {}", back["n"][1]);
}
