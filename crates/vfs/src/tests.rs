use crate::fs::{Changes, Error, Fs, Kind, ROOT};

fn names(fs: &Fs, dir: u32) -> Vec<String> {
    (0..).map_while(|i| fs.readdir(dir, i).unwrap().map(|(n, _, _)| n.to_string())).collect()
}

#[test]
fn create_write_read() {
    let mut fs = Fs::new();
    fs.mkdir_all(ROOT, "/a/b", 1).unwrap();
    let f = fs.create_file(ROOT, "/a/b/f.txt", false, false, 2).unwrap();
    fs.write_at(f, 0, b"hello", 3).unwrap();
    fs.write_at(f, 7, b"!", 4).unwrap(); // gap is zero-filled
    assert_eq!(fs.data(f).unwrap(), b"hello\0\0!");
    let mut buf = [0u8; 4];
    assert_eq!(fs.read_at(f, 6, &mut buf).unwrap(), 2);
    assert_eq!(&buf[..2], b"\0!");
    assert_eq!(fs.get(f).unwrap().mtime, 4);
    assert_eq!(fs.lookup(ROOT, "a/./b/../b/f.txt").unwrap(), f);
    let b = fs.lookup(ROOT, "/a/b").unwrap();
    assert_eq!(fs.lookup(b, "f.txt").unwrap(), f);
    assert_eq!(fs.lookup(ROOT, "/..").unwrap(), ROOT);
}

#[test]
fn create_flags() {
    let mut fs = Fs::new();
    let f = fs.create_file(ROOT, "x", false, false, 0).unwrap();
    fs.write_at(f, 0, b"abc", 0).unwrap();
    assert_eq!(fs.create_file(ROOT, "x", true, false, 0), Err(Error::Exist));
    assert_eq!(fs.create_file(ROOT, "x", false, false, 0), Ok(f));
    assert_eq!(fs.data(f).unwrap(), b"abc");
    assert_eq!(fs.create_file(ROOT, "x", false, true, 0), Ok(f));
    assert_eq!(fs.data(f).unwrap(), b"");
    fs.mkdir(ROOT, "d", 0).unwrap();
    assert_eq!(fs.create_file(ROOT, "d", false, false, 0), Err(Error::IsDir));
    assert_eq!(fs.create_file(ROOT, "missing/x", false, false, 0), Err(Error::NoEnt));
    assert_eq!(fs.create_file(ROOT, "x/y", false, false, 0), Err(Error::NotDir));
}

#[test]
fn errors() {
    let mut fs = Fs::new();
    fs.mkdir(ROOT, "d", 0).unwrap();
    assert_eq!(fs.mkdir(ROOT, "d", 0), Err(Error::Exist));
    fs.create_file(ROOT, "d/f", false, false, 0).unwrap();
    assert_eq!(fs.rmdir(ROOT, "d", 0), Err(Error::NotEmpty));
    assert_eq!(fs.unlink(ROOT, "d", 0), Err(Error::IsDir));
    assert_eq!(fs.rmdir(ROOT, "d/f", 0), Err(Error::NotDir));
    assert_eq!(fs.lookup(ROOT, "nope"), Err(Error::NoEnt));
    assert_eq!(fs.mkdir(ROOT, "/", 0), Err(Error::Exist));
    assert_eq!(fs.mkdir(ROOT, "d/..", 0), Err(Error::Inval));
    fs.unlink(ROOT, "d/f", 0).unwrap();
    fs.rmdir(ROOT, "d", 0).unwrap();
    assert_eq!(fs.inode_count(), 1);
}

#[test]
fn readdir_sorted() {
    let mut fs = Fs::new();
    for n in ["b", "a", "c"] {
        fs.create_file(ROOT, n, false, false, 0).unwrap();
    }
    fs.mkdir(ROOT, "dir", 0).unwrap();
    assert_eq!(names(&fs, ROOT), ["a", "b", "c", "dir"]);
    assert_eq!(fs.readdir(ROOT, 3).unwrap().unwrap().2, Kind::Dir);
    assert_eq!(fs.readdir(ROOT, 4).unwrap(), None);
}

#[test]
fn rename_cases() {
    let mut fs = Fs::new();
    fs.mkdir_all(ROOT, "/src/sub", 0).unwrap();
    let f = fs.create_file(ROOT, "/src/sub/f", false, false, 0).unwrap();
    fs.write_at(f, 0, b"1", 0).unwrap();
    // Rename over an existing file replaces it (rustc renames tmp files into place).
    let g = fs.create_file(ROOT, "/g", false, false, 0).unwrap();
    fs.write_at(g, 0, b"old", 0).unwrap();
    fs.rename(ROOT, "/src/sub/f", ROOT, "/g", 0).unwrap();
    assert_eq!(fs.data(fs.lookup(ROOT, "/g").unwrap()).unwrap(), b"1");
    assert_eq!(fs.lookup(ROOT, "/src/sub/f"), Err(Error::NoEnt));
    // Same directory fd on both sides (the browser_wasi_shim bug from WP-02).
    fs.rename(ROOT, "/g", ROOT, "/h", 0).unwrap();
    assert!(fs.lookup(ROOT, "/h").is_ok());
    // Directories.
    fs.rename(ROOT, "/src", ROOT, "/moved", 0).unwrap();
    assert!(fs.lookup(ROOT, "/moved/sub").is_ok());
    assert_eq!(fs.rename(ROOT, "/moved", ROOT, "/moved/sub/x", 0), Err(Error::Inval));
    fs.create_file(ROOT, "/moved/sub/y", false, false, 0).unwrap();
    fs.mkdir(ROOT, "/empty", 0).unwrap();
    assert_eq!(fs.rename(ROOT, "/empty", ROOT, "/moved", 0), Err(Error::NotEmpty));
}

#[test]
fn rename_onto_nonempty_dir_fails() {
    let mut fs = Fs::new();
    fs.mkdir_all(ROOT, "/a", 0).unwrap();
    fs.mkdir_all(ROOT, "/b/x", 0).unwrap();
    assert_eq!(fs.rename(ROOT, "/a", ROOT, "/b", 0), Err(Error::NotEmpty));
    fs.create_file(ROOT, "/file", false, false, 0).unwrap();
    assert_eq!(fs.rename(ROOT, "/file", ROOT, "/b", 0), Err(Error::IsDir));
    assert_eq!(fs.rename(ROOT, "/a", ROOT, "/file", 0), Err(Error::NotDir));
}

#[test]
fn persistence_changes() {
    let mut fs = Fs::new();
    fs.mkdir_all(ROOT, "/tmp", 0).unwrap();
    let proj = fs.mkdir_all(ROOT, "/project/src", 0).unwrap();
    let project = fs.lookup(ROOT, "/project").unwrap();
    fs.set_persist_tree(project, true);
    let first = fs.take_changes();
    assert_eq!(first.removed, Vec::<String>::new());
    assert_eq!(first.dirty, [("/project".into(), Kind::Dir), ("/project/src".into(), Kind::Dir)]);
    assert_eq!(fs.take_changes(), Changes::default());

    let seq = fs.change_seq;
    let f = fs.create_file(proj, "main.rs", false, false, 0).unwrap();
    fs.write_at(f, 0, b"fn main() {}", 0).unwrap();
    fs.create_file(ROOT, "/tmp/scratch", false, false, 0).unwrap(); // not persisted
    assert_ne!(fs.change_seq, seq);
    let c = fs.take_changes();
    assert_eq!(c.dirty, [("/project/src".into(), Kind::Dir), ("/project/src/main.rs".into(), Kind::File)]);

    // Moving out of the persisted tree reads as a removal; moving in as new files.
    fs.rename(ROOT, "/project/src/main.rs", ROOT, "/tmp/main.rs", 0).unwrap();
    let c = fs.take_changes();
    assert_eq!(c.removed, ["/project/src/main.rs"]);
    assert_eq!(c.dirty, [("/project/src".into(), Kind::Dir)]);
    fs.rename(ROOT, "/tmp/main.rs", ROOT, "/project/lib.rs", 0).unwrap();
    let c = fs.take_changes();
    assert!(c.dirty.contains(&("/project/lib.rs".into(), Kind::File)));
    assert!(c.removed.is_empty());

    // Remove then recreate within one batch: removal first, then the new file.
    fs.unlink(ROOT, "/project/lib.rs", 0).unwrap();
    fs.create_file(ROOT, "/project/lib.rs", false, false, 0).unwrap();
    let c = fs.take_changes();
    assert_eq!(c.removed, ["/project/lib.rs"]);
    assert!(c.dirty.contains(&("/project/lib.rs".into(), Kind::File)));

    // A file written and then deleted is not reported dirty.
    let t = fs.create_file(ROOT, "/project/t", false, false, 0).unwrap();
    fs.write_at(t, 0, b"x", 0).unwrap();
    fs.remove_all(ROOT, "/project/src", 0).unwrap();
    fs.unlink(ROOT, "/project/t", 0).unwrap();
    let c = fs.take_changes();
    assert_eq!(c.removed, ["/project/src", "/project/t"]);
    assert_eq!(c.dirty, [("/project".into(), Kind::Dir)]);
}

#[test]
fn inodes_are_reused() {
    let mut fs = Fs::new();
    for i in 0..100 {
        let n = format!("f{i}");
        fs.create_file(ROOT, &n, false, false, 0).unwrap();
        fs.unlink(ROOT, &n, 0).unwrap();
    }
    assert_eq!(fs.inode_count(), 1);
    assert!(fs.create_file(ROOT, "x", false, false, 0).unwrap() <= 1);
}

#[test]
fn fd_tables() {
    use crate::fd::{Fd, Procs};
    let mut p = Procs::default();
    let a = p.new_proc();
    let b = p.new_proc();
    let fd = |ino| Fd { ino, pos: 0, append: false, preopen: None };
    assert_eq!(p.open(a, fd(1)), Ok(0));
    assert_eq!(p.open(a, fd(2)), Ok(1));
    assert_eq!(p.open(b, fd(9)), Ok(0)); // separate tables
    p.get(a, 1).unwrap().pos = 42;
    assert_eq!(p.get(a, 1).unwrap().pos, 42);
    p.close(a, 0).unwrap();
    assert_eq!(p.close(a, 0), Err(Error::BadF));
    assert_eq!(p.open(a, fd(3)), Ok(0)); // lowest free
    p.renumber(a, 1, 5).unwrap();
    assert_eq!(p.get(a, 5).unwrap().pos, 42);
    assert_eq!(p.get(a, 1).map(|f| f.ino), Err(Error::BadF));
    p.free_proc(a);
    assert_eq!(p.get(a, 0).map(|f| f.ino), Err(Error::BadF));
    assert_eq!(p.new_proc(), a); // pid reused
}

#[test]
fn symlinks() {
    let mut fs = Fs::new();
    fs.mkdir_all(ROOT, "/sysroot/lib/rustlib", 0).unwrap();
    fs.mkdir_all(ROOT, "/sysroot/bin", 0).unwrap();
    let real = fs.create_file(ROOT, "/rustc.wasm", false, false, 0).unwrap();
    // rustc finds its sysroot from argv[0] only if argv[0] is a symlink.
    let link = fs.symlink(ROOT, "/rustc.wasm", "/sysroot/bin/rustc", 0).unwrap();
    assert_eq!(fs.readlink(ROOT, "/sysroot/bin/rustc"), Ok("/rustc.wasm"));
    assert_eq!(fs.lookup(ROOT, "/sysroot/bin/rustc"), Ok(real));
    assert_eq!(fs.lookup_nofollow(ROOT, "/sysroot/bin/rustc"), Ok(link));
    assert_eq!(fs.get(link).unwrap().kind(), Kind::Symlink);
    assert_eq!(fs.readlink(ROOT, "/rustc.wasm"), Err(Error::Inval));
    // Relative targets resolve from the link's directory; links in the middle of a path work.
    fs.symlink(ROOT, "../lib", "/sysroot/bin/libdir", 0).unwrap();
    assert_eq!(fs.lookup(ROOT, "/sysroot/bin/libdir/rustlib"), fs.lookup(ROOT, "/sysroot/lib/rustlib"));
    // Loops are detected; unlink removes the link, not the target.
    fs.symlink(ROOT, "/loop2", "/loop1", 0).unwrap();
    fs.symlink(ROOT, "/loop1", "/loop2", 0).unwrap();
    assert_eq!(fs.lookup(ROOT, "/loop1"), Err(Error::Loop));
    fs.unlink(ROOT, "/sysroot/bin/rustc", 0).unwrap();
    assert!(fs.lookup(ROOT, "/rustc.wasm").is_ok());
    // Symlinks inside a persisted tree are not reported for persistence.
    let p = fs.mkdir_all(ROOT, "/project", 0).unwrap();
    fs.set_persist_tree(p, true);
    fs.take_changes();
    fs.symlink(ROOT, "/rustc.wasm", "/project/link", 0).unwrap();
    assert!(fs.take_changes().dirty.iter().all(|(path, _)| path != "/project/link"));
}
