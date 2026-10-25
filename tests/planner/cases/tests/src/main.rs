fn main() {
    println!("{}", tests::add(1, 2));
}

#[test]
fn bin_test() {
    assert_eq!(tests::add(0, 0), 0);
}
