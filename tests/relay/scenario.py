#!/usr/bin/env python3
"""WP-38's scenario, played by a scripted MCP client: what the agent has to manage, through the
relay alone. Starts tools/relay/relay.py (an MCP server on stdio), then:

  project with a serde dependency → seeded compile error found by cargo_check and fixed →
  failing test found by cargo_test and fixed (rerun alone by name first) → Clippy clean →
  rustfmt clean → cargo_run prints the expected output.

Also checks the relay's guard: a WebSocket with the wrong token or a foreign Origin is refused.

    python3 -I tests/relay/scenario.py [--browser headless|headed] [--port 8791]
Prints one line per step; exits 1 at the first failure. Results: build/wp-38/scenario-<mode>.json.
"""

import argparse
import base64
import http.client
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PROJECT = 'wp38-demo'

CARGO = '''[package]
name = "wp38-demo"
version = "0.1.0"
edition = "2021"

[dependencies]
'''
LIB_BROKEN = '''use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// "x, y" → a point.
pub fn parse(s: &str) -> Point {
    let v: Vec<i32> = s.split(',').map(|p| p.trim().parse().unwrap()).collect();
    Point { x: v[0], y: "oops" }
}

pub fn dist2(p: &Point) -> i32 { return p.x * p.x + p.y * p.y; }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses() {
        assert_eq!(parse("1, 2"), Point { x: 1, y: 2 });
    }

    #[test]
    fn distance() {
        assert_eq!(dist2(&Point { x: 3, y: 4 }), 24);
    }
}
'''
MAIN = '''fn main() {
    let p = wp38_demo::parse("3, 4");
    println!("{:?} has dist2 {}", p, wp38_demo::dist2(&p));
}
'''


class Mcp:
    def __init__(self, args):
        env = {**os.environ, 'PYTHONUNBUFFERED': '1'}
        self.log = open(REPO / f'build/wp-38/relay-{args.browser}.log', 'w')
        self.p = subprocess.Popen([sys.executable, '-I', str(REPO / 'tools/relay/relay.py'), '--port', str(args.port), '--browser', args.browser],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, env=env, cwd=REPO)
        self.id = 0

    def request(self, method, params=None):
        self.id += 1
        self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': self.id, 'method': method, 'params': params or {}}).encode() + b'\n')
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError('the relay exited; see build/wp-38/relay-*.log')
            m = json.loads(line)
            if m.get('id') == self.id:
                if 'error' in m:
                    raise RuntimeError(f'{method}: {m["error"]}')
                return m['result']

    def notify(self, method):
        self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': method}).encode() + b'\n')
        self.p.stdin.flush()

    def tool(self, tool_name, /, **args):
        r = self.request('tools/call', {'name': tool_name, 'arguments': args})
        text = r['content'][0]['text']
        if r.get('isError'):
            raise RuntimeError(f'{tool_name}: {text}')
        return json.loads(text)

    def close(self):
        self.p.stdin.close()
        try:
            self.p.wait(15)
        except subprocess.TimeoutExpired:
            self.p.terminate()


def ws_refused(port, origin, token):
    """A WebSocket handshake to the relay; True if it's refused."""
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    c.request('GET', f'/relay?token={token}', headers={
        'Upgrade': 'websocket', 'Connection': 'Upgrade', 'Origin': origin,
        'Sec-WebSocket-Key': base64.b64encode(os.urandom(16)).decode(), 'Sec-WebSocket-Version': '13'})
    return c.getresponse().status == 403


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--browser', default='headless', choices=['headless', 'headed'])
    ap.add_argument('--port', type=int, default=8791)
    args = ap.parse_args()
    (REPO / 'build/wp-38').mkdir(parents=True, exist_ok=True)
    steps, t_start = [], time.monotonic()

    def step(what, ok, detail=''):
        steps.append({'step': what, 'ok': ok, 'detail': detail, 's': round(time.monotonic() - t_start, 1)})
        print(f'  {"ok  " if ok else "FAIL"} {what}{f": {detail}" if detail else ""}', flush=True)
        if not ok:
            raise SystemExit(1)

    mcp = Mcp(args)
    try:
        init = mcp.request('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'scenario', 'version': '0'}})
        mcp.notify('notifications/initialized')
        tools = [t['name'] for t in mcp.request('tools/list')['tools']]
        step('MCP initialize + tools/list', init['serverInfo']['name'] == 'rust-browser-ide' and 'cargo_test' in tools, f'{len(tools)} tools')
        step('WebSocket guard: wrong token and foreign Origin refused',
             ws_refused(args.port, f'http://127.0.0.1:{args.port}', 'wrong') and ws_refused(args.port, 'https://evil.example', 'x'))

        t = time.monotonic()
        r = mcp.tool('project_create', project=PROJECT, overwrite=True, files={'Cargo.toml': CARGO, 'src/lib.rs': LIB_BROKEN, 'src/main.rs': MAIN})
        step('project_create (browser started, page connected)', r['project'] == PROJECT, f'{time.monotonic() - t:.1f} s')
        r = mcp.tool('dependency_add', project=PROJECT, name='serde', version='1', features=['derive'])
        step('dependency_add serde (derive) from crates.io via the proxy', r['ok'], ', '.join(f'{c["name"]} {c.get("to")}' for c in r['changes'][:6]))

        t = time.monotonic()
        r = mcp.tool('cargo_check', project=PROJECT)
        e = [d for d in r['diagnostics'] if d['level'] == 'error']
        step('cargo_check finds the seeded error', not r['ok'] and any(d['code'] == 'E0308' and d['file'] == 'src/lib.rs' for d in e),
             f'{e[0]["code"]} at {e[0]["file"]}:{e[0]["line"]} ({time.monotonic() - t:.1f} s, cold)' if e else json.dumps(r)[:300])
        lib = mcp.tool('file_read', project=PROJECT, path='src/lib.rs')['content'].replace('y: "oops"', 'y: v[1]')
        mcp.tool('file_write', project=PROJECT, path='src/lib.rs', content=lib)
        r = mcp.tool('cargo_check', project=PROJECT)
        step('fixed from the diagnostic; cargo_check ok', r['ok'] and r['errors'] == 0, f'{r["ms"]} ms')

        r = mcp.tool('cargo_test', project=PROJECT)
        failed = [x for x in r['tests'] if x['status'] == 'failed']
        step('cargo_test: one failing test with its message', r['counts']['failed'] == 1 and failed[0]['name'] == 'tests::distance' and '24' in failed[0].get('message', ''),
             f'{r["counts"]}; {failed[0]["message"].splitlines()[0] if failed else ""}')
        r = mcp.tool('cargo_test', project=PROJECT, filter='tests::distance', exact=True)
        step('the failing test alone, by name', [x['name'] for x in r['tests']] == ['tests::distance'] and r['counts']['failed'] == 1)
        mcp.tool('file_write', project=PROJECT, path='src/lib.rs', content=lib.replace('}), 24);', '}), 25);'))
        r = mcp.tool('cargo_test', project=PROJECT)
        step('fixed; cargo_test all pass', r['ok'] and r['counts'] == {'passed': 2, 'failed': 0, 'ignored': 0, 'filteredOut': 0}, json.dumps(r['counts']))

        r = mcp.tool('cargo_clippy', project=PROJECT)
        codes = sorted({d['code'] for d in r['diagnostics'] if d['code']})
        step('cargo_clippy reports needless_return', 'clippy::needless_return' in codes, ', '.join(codes))
        lib = mcp.tool('file_read', project=PROJECT, path='src/lib.rs')['content'].replace('{ return p.x * p.x + p.y * p.y; }', '{ p.x * p.x + p.y * p.y }')
        mcp.tool('file_write', project=PROJECT, path='src/lib.rs', content=lib)
        r = mcp.tool('cargo_clippy', project=PROJECT)
        step('fixed; cargo_clippy clean', r['ok'] and r['warnings'] == 0 and r['errors'] == 0, f'{len(r["diagnostics"])} diagnostics')

        r = mcp.tool('cargo_fmt', project=PROJECT, check=True)
        step('cargo_fmt --check finds unformatted code', not r['ok'] and [u['path'] for u in r['unformatted']] == ['src/lib.rs'], json.dumps(r)[:400])
        r = mcp.tool('cargo_fmt', project=PROJECT)
        r2 = mcp.tool('cargo_fmt', project=PROJECT, check=True)
        step('cargo_fmt formats; --check clean after', r['changed'] == ['src/lib.rs'] and r2['ok'])

        r = mcp.tool('cargo_run', project=PROJECT)
        step('cargo_run', r['ok'] and r['stdout'] == 'Point { x: 3, y: 4 } has dist2 25\n', repr(r.get('stdout')))
        r = mcp.tool('cargo_test', project=PROJECT)
        step('still all green after formatting', r['ok'], f'test run {r["ms"]["run"]} ms')
    finally:
        out = REPO / f'build/wp-38/scenario-{args.browser}.json'
        out.write_text(json.dumps({'browser': args.browser, 'steps': steps, 'total_s': round(time.monotonic() - t_start, 1)}, indent=1))
        mcp.close()
    print(f'scenario ({args.browser}) passed in {time.monotonic() - t_start:.0f} s')


if __name__ == '__main__':
    main()
