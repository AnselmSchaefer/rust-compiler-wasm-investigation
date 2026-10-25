// Build scripts that can't run in the sandbox (WP-21): what they would have printed instead, like
// cargo's `[target.<triple>.<links>]` overrides. A script needs one if it compiles C (the `cc`
// crate; no C compiler here yet) or runs a program other than rustc. Entries match a package
// name and a version prefix; `$OUT_DIR` in `stdout` becomes the run's OUT_DIR, and `files` are
// written there. WP-22's ecosystem matrix fills the built-in list.

export interface Override {
  name: string;
  /** "" matches every version; "0.2." every 0.2.x. */
  version: string;
  stdout: string;
  files?: Record<string, string>;
  /** Why the script can't run. */
  reason: string;
}

export const OVERRIDES: Override[] = [];

export function findOverride(list: Override[] | undefined, name: string, version: string): Override | undefined {
  return (list ?? OVERRIDES).find(o => o.name === name && version.startsWith(o.version));
}
