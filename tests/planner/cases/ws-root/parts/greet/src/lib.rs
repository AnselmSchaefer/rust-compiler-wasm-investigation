pub fn greet(who: &str) -> String {
    let s = format!("hello {who} {}", itoa::Buffer::new().format(1));
    if cfg!(feature = "loud") { s.to_uppercase() } else { s }
}
