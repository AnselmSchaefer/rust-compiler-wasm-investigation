#!/usr/bin/env bash
# WP-03 done-check: docs/patches.md covers every concern from PLAN.md WP-03 with a decision,
# and a base rustc tag is recorded in docs/decisions.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
doc=docs/patches.md
fail=0
for concern in "Threads" "Codegen backend loading" "Linking in-process" "Proc macros" "Metadata loading (mmap)" \
               "Sysroot / \`current_exe\` detection" "Error exit / unwinding" "LLVM builds for a WASI host"; do
  line=$(grep -F "**${concern}" "$doc" || true)
  if [ -z "$line" ]; then echo "FAIL: concern missing: $concern"; fail=1; continue; fi
  grep -qE '\*\*(keep|rewrite|config|drop|verify)' <<<"$line" || { echo "FAIL: no decision for: $concern"; fail=1; }
  echo "  ok   $concern"
done
grep -qE '^- \*\*Base rustc tag: `1\.[0-9]+\.[0-9]+`\*\*' docs/decisions.md || { echo "FAIL: no base tag in docs/decisions.md"; fail=1; }
tag=$(grep -oE 'Base rustc tag: `1\.[0-9]+\.[0-9]+`' docs/decisions.md | grep -oE '1\.[0-9]+\.[0-9]+')
echo "  ok   base tag $tag"
[ -x scripts/fetch-patch-sources.sh ] && echo "  ok   scripts/fetch-patch-sources.sh"
[ $fail = 0 ] && echo "WP-03 verified."
exit $fail
