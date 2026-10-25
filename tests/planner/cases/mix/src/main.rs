use rand::RngExt;

fn main() {
    let re = regex::Regex::new(r"(\w+)@(\w+)").unwrap();
    let caps = re.captures("mail: ferris@rust").unwrap();
    println!("user={} host={}", &caps[1], &caps[2]);
    let v = json::json!({ "user": &caps[1] });
    println!("{v}");
    let n: u32 = rand::rng().random_range(1..=6);
    assert!((1..=6).contains(&n));
    println!("dice ok");
}
