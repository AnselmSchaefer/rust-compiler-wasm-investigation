#!/usr/bin/env python3
# Run one command and print {"ms", "code", "maxRssKB"} as JSON (peak RSS of the child, Linux).
# Usage: measure.py <cwd> <cmd> [args...]
import json, os, resource, subprocess, sys, time

cwd, cmd = sys.argv[1], sys.argv[2:]
t = time.perf_counter()
p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
ms = round((time.perf_counter() - t) * 1000)
rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
print(json.dumps({"ms": ms, "code": p.returncode, "maxRssKB": rss,
                  "stdout": p.stdout.decode(errors="replace")[-2000:], "stderr": p.stderr.decode(errors="replace")[-2000:]}))
