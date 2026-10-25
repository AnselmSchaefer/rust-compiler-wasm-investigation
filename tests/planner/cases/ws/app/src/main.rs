fn main() {
    let mut b = itoa::Buffer::new();
    println!("{} {} {}", core_lib::describe(), util::twice(21), b.format(7u8));
}
