use num_traits::{Float, ToPrimitive};

#[rustversion::since(1.80)]
fn version() -> &'static str { "rustc >= 1.80" }
#[rustversion::before(1.80)]
fn version() -> &'static str { "rustc < 1.80" }

fn main() -> anyhow::Result<()> {
    println!("{}", version());
    println!("num-traits: {} {:?}", 2.0f64.sqrt().to_f32().unwrap(), 7.5f32.floor());
    println!("libc: EINVAL={}", libc::EINVAL);
    let ts: proc_macro2::TokenStream = "fn f() -> u8 { 1 }".parse().unwrap();
    println!("proc-macro2: {}", ts);
    println!("linkb: {}", linkb::info());
    let e = anyhow::anyhow!("an error").context("with context");
    println!("anyhow: {:#}", e);
    Ok(())
}
