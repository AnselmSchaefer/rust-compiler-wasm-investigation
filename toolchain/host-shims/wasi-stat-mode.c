// WASI preview 1 has no file permissions, so wasi-libc's stat family returns an st_mode with only
// the file type bits. Rust's std then reports every existing file as read-only, and rustc refuses
// to link objects it has just written ("output file ... is not writeable"). Linked into rustc.wasm
// with --wrap: when the host gave no permission bits, report 0644 (0755 for directories).
#include <sys/stat.h>

int __real_stat(const char *restrict, struct stat *restrict);
int __real_lstat(const char *restrict, struct stat *restrict);
int __real_fstat(int, struct stat *);
int __real_fstatat(int, const char *restrict, struct stat *restrict, int);

static int fix(int r, struct stat *s) {
  if (r == 0 && (s->st_mode & 07777) == 0)
    s->st_mode |= S_ISDIR(s->st_mode) ? 0755 : 0644;
  return r;
}

int __wrap_stat(const char *restrict p, struct stat *restrict s) { return fix(__real_stat(p, s), s); }
int __wrap_lstat(const char *restrict p, struct stat *restrict s) { return fix(__real_lstat(p, s), s); }
int __wrap_fstat(int fd, struct stat *s) { return fix(__real_fstat(fd, s), s); }
int __wrap_fstatat(int fd, const char *restrict p, struct stat *restrict s, int f) {
  return fix(__real_fstatat(fd, p, s, f), s);
}
