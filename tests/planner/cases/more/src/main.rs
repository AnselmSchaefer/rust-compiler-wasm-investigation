use base64::Engine;
use byteorder::{ByteOrder, LittleEndian};
use itertools::Itertools;
use std::hash::Hasher;
use typenum::Unsigned;

static GREETING: once_cell::sync::Lazy<String> = once_cell::sync::Lazy::new(|| "hi".repeat(2));

fn main() {
    log::info!("not printed: no logger");
    let v: smallvec::SmallVec<[u32; 4]> = (1..=5).collect();
    println!("{}", v.iter().map(|x| x * x).join(","));
    let mut m = indexmap::IndexMap::new();
    m.insert("b", 2);
    m.insert("a", 1);
    println!("{:?}", m.keys().collect::<Vec<_>>());
    println!("{}", base64::engine::general_purpose::STANDARD.encode(b"ferris"));
    println!("{}", hex::encode(bytes::Bytes::from_static(b"\x01\xab")));
    let req = semver::VersionReq::parse(">=1.2, <2").unwrap();
    println!("{}", req.matches(&semver::Version::parse("1.5.0").unwrap()));
    let mut h = fnv::FnvHasher::default();
    h.write(b"x");
    println!("{:x}", h.finish());
    let mut a = arrayvec::ArrayVec::<u8, 4>::new();
    a.push(LittleEndian::read_u16(&[0x34, 0x12]) as u8);
    println!("{:?} {} {}", a, typenum::U42::to_u32(), *GREETING);
}
