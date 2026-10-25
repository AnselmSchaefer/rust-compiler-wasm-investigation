#!/usr/bin/env python3
"""After tests/relay/agent-run.sh: check, through the relay, that the agent's project is done.
Projects live in the browser profile's OPFS, per origin: pass the agent run's --profile and
--port, or the relay's defaults (build/relay/profile, 8790) for your own session (close the
session first: one browser per profile).
    python3 -I tests/relay/check-agent.py --project wp38-agent [--profile DIR] [--port 8803] [--browser headless]"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scenario import Mcp  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', required=True)
    ap.add_argument('--port', type=int, default=8790)
    ap.add_argument('--browser', default='headless')
    ap.add_argument('--profile', help="the agent run's browser profile (where its projects are)")
    a = ap.parse_args()
    mcp = Mcp(argparse.Namespace(port=a.port, browser=a.browser, profile=a.profile))
    ok = True
    try:
        mcp.request('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'check', 'version': '0'}})
        files = mcp.tool('file_list', project=a.project)['files']
        manifest = mcp.tool('file_read', project=a.project, path='Cargo.toml')['content']
        checks = {
            'serde dependency with derive': 'serde' in manifest and 'derive' in manifest,
            'cargo_check ok': mcp.tool('cargo_check', project=a.project)['ok'],
        }
        t = mcp.tool('cargo_test', project=a.project)
        checks[f'cargo_test all pass {t.get("counts")}'] = t['ok'] and t['counts']['failed'] == 0 and t['counts']['passed'] >= 2
        c = mcp.tool('cargo_clippy', project=a.project)
        checks[f'cargo_clippy clean ({c.get("warnings")} warnings)'] = c['ok'] and c['warnings'] == 0
        checks['cargo_fmt --check clean'] = mcp.tool('cargo_fmt', project=a.project, check=True)['ok']
        r = mcp.tool('cargo_run', project=a.project)
        checks[f'cargo_run {r.get("stdout")!r}'] = r['ok'] and 'dist2 25' in r['stdout']
        for k, v in checks.items():
            print(f'  {"ok  " if v else "FAIL"} {k}')
            ok &= v
        print(f'  files: {", ".join(files)}')
    finally:
        mcp.close()
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
