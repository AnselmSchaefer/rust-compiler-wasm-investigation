#[test]
fn integration() {
    assert_eq!(tests::find(b"xyz", b'z'), Some(2));
    assert_eq!(itoa::Buffer::new().format(7u8), "7");
}
