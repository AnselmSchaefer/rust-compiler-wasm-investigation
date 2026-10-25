//! Small functions with unit tests and a doc test.

/// The position of the first `b` in `s`.
///
/// ```
/// assert_eq!(tests::find(b"hello", b'l'), Some(2));
/// ```
pub fn find(s: &[u8], b: u8) -> Option<usize> {
    memchr::memchr(b, s)
}

pub fn add(a: u32, b: u32) -> u32 {
    a + b
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn adds() {
        assert_eq!(add(2, 3), 5);
    }

    #[test]
    fn finds() {
        assert_eq!(find(b"abc", b'c'), Some(2));
    }

    #[test]
    fn formats_with_a_dev_dependency() {
        let mut b = itoa::Buffer::new();
        assert_eq!(b.format(add(40, 2)), "42");
    }

    #[test]
    fn failing() {
        println!("output of the failing test");
        assert_eq!(add(1, 1), 3, "one plus one");
    }

    #[test]
    #[ignore]
    fn ignored() {}
}
