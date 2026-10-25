// WP-19 demo: serde derives over a range of shapes and attributes. Built twice, with the native
// serde_derive and with serde_derive compiled to Wasm (pm-shim-serde); the expanded code
// (-Zunpretty=expanded) and the output must be identical.
use serde_derive::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Unit;

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Tuple(u8, String);

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    user_name: String,
    #[serde(default)]
    retry_count: u32,
    #[serde(rename = "TTL", skip_serializing_if = "Option::is_none")]
    ttl: Option<f64>,
    #[serde(skip)]
    cache: Vec<u8>,
    tags: BTreeMap<String, i64>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "type", content = "data")]
enum Event<'a, T> {
    Start,
    Progress { done: u64, total: u64 },
    #[serde(borrow)]
    Message(Cow<'a, str>),
    Value(T),
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(untagged)]
enum Number {
    Int(i64),
    Float(f64),
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Outer {
    #[serde(flatten)]
    inner: Inner,
    r#type: char,
    raw: [u16; 3],
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Inner {
    a: bool,
    #[serde(with = "hex_byte")]
    b: u8,
}

mod hex_byte {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u8, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{v:02x}"))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
        let s = <&str>::deserialize(d)?;
        u8::from_str_radix(s, 16).map_err(serde::de::Error::custom)
    }
}

fn main() {
    let cfg = Config { user_name: "ferris".into(), retry_count: 3, ttl: Some(1.5), cache: vec![1], tags: [("x".to_string(), -1)].into() };
    let s = serde_json::to_string(&cfg).unwrap();
    println!("{s}");
    let back: Config = serde_json::from_str(&s).unwrap();
    assert_eq!(back.cache, Vec::<u8>::new());
    println!("{}", serde_json::from_str::<Config>(r#"{"userName":"x","tags":{},"bogus":1}"#).unwrap_err());
    for e in [Event::Start, Event::Progress { done: 1, total: 2 }, Event::Message("hi".into()), Event::Value(Tuple(7, "t".into()))] {
        let j = serde_json::to_string(&e).unwrap();
        let back: Event<Tuple> = serde_json::from_str(&j).unwrap();
        assert_eq!(back, e);
        println!("{j}");
    }
    println!("{} {}", serde_json::to_string(&Number::Int(4)).unwrap(), serde_json::to_string(&Number::Float(0.5)).unwrap());
    let o = Outer { inner: Inner { a: true, b: 0xab }, r#type: 'z', raw: [1, 2, 3] };
    let j = serde_json::to_string(&o).unwrap();
    assert_eq!(serde_json::from_str::<Outer>(&j).unwrap(), o);
    println!("{j} {}", serde_json::to_string(&Unit).unwrap());
}
