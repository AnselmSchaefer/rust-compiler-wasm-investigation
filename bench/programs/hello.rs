fn main() {
    let t = std::thread::Builder::new().spawn(|| 40 + 2);
    match t.map(|h| h.join()) {
        Ok(Ok(n)) => println!("Hello from Wasm, thread says {n}"),
        _ => println!("Hello from Wasm (no threads)"),
    }
}
