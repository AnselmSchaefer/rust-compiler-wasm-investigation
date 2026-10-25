#!/usr/bin/env python3
"""The local relay between an agent and the browser IDE (WP-38).

    agent ⇄ MCP (stdio) ⇄ relay ⇄ WebSocket ⇄ the IDE page in Chromium (app/ide.ts)

The agent starts the relay as an MCP server (stdio). The relay
  * offers the tools of tools/relay/tools.json and forwards each call to the page, which runs it
    with the toolchain it already has (web/agent/tools.ts), and returns the page's JSON result;
  * serves the app (build/www/app) and the toolchain release (build/release) with the
    cross-origin isolation headers the page needs, and proxies /index/ to index.crates.io, so the
    sparse index is same-origin (index.crates.io sends no CORS headers; crate downloads from
    static.crates.io allow any origin);
  * starts Chromium through Playwright (tools/relay/browser.mjs), headed to watch or headless,
    with a profile of its own (build/relay/profile) so projects and caches survive; or, with
    --browser none, prints the URL to open (also in build/relay/url.txt). The browser starts on
    the first MCP initialize. If the port is taken, a free one is used.

Security: it listens on 127.0.0.1 only. The page connects with a token made for this run, and the
WebSocket's Origin must be the relay's own, because any website could otherwise talk to a
localhost WebSocket. Only the standard library is used. Logs go to stderr; stdout is MCP's.

    python3 tools/relay/relay.py [--port 8790] [--browser headed|headless|none] [--profile DIR] [--no-mcp]
"""

import argparse
import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import secrets
import shutil
import signal
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
APP = REPO / 'build/www/app'
RELEASES = REPO / 'build/release'
TOOLS = json.loads((Path(__file__).with_name('tools.json')).read_text())['tools']
UPSTREAM_INDEX = 'https://index.crates.io/'
USER_AGENT = 'browser-rust-ide-relay/0.1 (WP-38 local dev tool)'
PROTOCOL = '2025-06-18'
CALL_TIMEOUT = 30 * 60  # a cold build of a big graph takes minutes
PAGE_WAIT = 120

TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
         '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json'}
ISOLATION = {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
             'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store'}


def log(*a):
    print('relay:', *a, file=sys.stderr, flush=True)


class Relay:
    def __init__(self, port, browser, profile):
        self.port = port
        self.browser_mode = browser
        self.profile = profile
        self.token = secrets.token_urlsafe(24)
        self.origin = f'http://127.0.0.1:{port}'
        self.page = None              # the connected page's WebSocket writer
        self.page_ready = asyncio.Event()
        self.pending = {}             # call id → Future
        self.next_id = 0
        self.index_cache = {}         # path → (status, body); the index changes, so only for this run
        self.browser = None
        self.out = sys.stdout.buffer

    @property
    def url(self):
        return f'{self.origin}/ide.html?token={self.token}'

    # --- HTTP

    async def serve(self, reader, writer):
        try:
            while True:
                head = await reader.readuntil(b'\r\n\r\n')
                lines = head.decode('latin-1').split('\r\n')
                method, target, _ = lines[0].split(' ', 2)
                headers = {k.strip().lower(): v.strip() for k, v in (l.split(':', 1) for l in lines[1:] if ':' in l)}
                path = urllib.parse.urlsplit(target)
                if path.path == '/relay' and headers.get('upgrade', '').lower() == 'websocket':
                    await self.websocket(reader, writer, headers, urllib.parse.parse_qs(path.query))
                    return
                if method not in ('GET', 'HEAD'):
                    await self.respond(writer, 405, b'method not allowed')
                    continue
                await self.get(writer, urllib.parse.unquote(path.path), headers, method == 'HEAD')
                if headers.get('connection', '').lower() == 'close':
                    break
        except (asyncio.IncompleteReadError, ConnectionError, ValueError):
            pass
        finally:
            writer.close()

    async def respond(self, writer, status, body, headers=None, head=False):
        reason = {200: 'OK', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 502: 'Bad Gateway'}.get(status, 'OK')
        h = {'Content-Length': str(len(body)), **ISOLATION, **(headers or {})}
        writer.write(f'HTTP/1.1 {status} {reason}\r\n'.encode() + ''.join(f'{k}: {v}\r\n' for k, v in h.items()).encode() + b'\r\n')
        if not head:
            writer.write(body)
        await writer.drain()

    async def get(self, writer, path, headers, head):
        if path.startswith('/index/'):
            status, body = await self.index(path[len('/index/'):])
            return await self.respond(writer, status, body, {'Content-Type': 'application/json' if path.endswith('.json') else 'text/plain'}, head)
        base, rel = (RELEASES, path[len('/release/'):]) if path.startswith('/release/') else (APP, path.lstrip('/') or 'ide.html')
        file = (base / rel).resolve()
        if base.resolve() not in file.parents and file != base.resolve():
            return await self.respond(writer, 403, b'forbidden')
        if file.is_dir():
            file = file / 'index.html'
        # A release has only .br files, served as such (like scripts/serve.mjs, or a CDN).
        br = 'br' in headers.get('accept-encoding', '') and file.with_name(file.name + '.br').is_file()
        if not br and not file.is_file():
            return await self.respond(writer, 404, b'not found')
        body = (file.with_name(file.name + '.br') if br else file).read_bytes()
        h = {'Content-Type': TYPES.get(file.suffix, mimetypes.guess_type(file.name)[0] or 'application/octet-stream')}
        if br:
            h['Content-Encoding'] = 'br'
        await self.respond(writer, 200, body, h, head)

    async def index(self, rel):
        """index.crates.io, same-origin: its files (and its 404s) as they are."""
        if '..' in rel.split('/'):
            return 403, b'forbidden'
        if rel not in self.index_cache:
            def fetch():
                req = urllib.request.Request(UPSTREAM_INDEX + rel, headers={'User-Agent': USER_AGENT})
                try:
                    with urllib.request.urlopen(req, timeout=60) as r:
                        return r.status, r.read()
                except urllib.error.HTTPError as e:
                    return e.code, e.read()
                except (urllib.error.URLError, TimeoutError) as e:
                    return 502, f'index.crates.io: {e}'.encode()
            status, body = await asyncio.to_thread(fetch)
            if status in (200, 404):
                self.index_cache[rel] = (status, body)
            else:
                return status, body
        return self.index_cache[rel]

    # --- WebSocket (RFC 6455, enough for one page)

    async def websocket(self, reader, writer, headers, query):
        if headers.get('origin') != self.origin or query.get('token', [''])[0] != self.token:
            log(f'refused a WebSocket from origin {headers.get("origin")!r}')
            return await self.respond(writer, 403, b'forbidden')
        accept = base64.b64encode(hashlib.sha1((headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        writer.write(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
        await writer.drain()
        if self.page is not None:
            log('a new page connected; dropping the old one')
            self.drop_page('the IDE page was replaced by a new one')
        self.page = writer
        log('page connected')
        try:
            async for text in self.frames(reader, writer):
                m = json.loads(text)
                if m.get('type') == 'hello':
                    log(f'page ready: rustc {m.get("rustcId")}, {len(m.get("tools", []))} tools')
                    self.page_ready.set()
                elif m.get('type') in ('result', 'error'):
                    f = self.pending.pop(m.get('id'), None)
                    if f and not f.done():
                        f.set_result(m)
        finally:
            if self.page is writer:
                self.page = None
                self.page_ready.clear()
                self.drop_page('the IDE page disconnected (reloaded or closed); call the tool again')
                log('page disconnected')

    def drop_page(self, why):
        for f in self.pending.values():
            if not f.done():
                f.set_result({'type': 'error', 'error': why})
        self.pending.clear()

    async def frames(self, reader, writer):
        parts = []
        while True:
            b0, b1 = await reader.readexactly(2)
            op, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack('>H', await reader.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', await reader.readexactly(8))[0]
            mask = await reader.readexactly(4) if b1 & 0x80 else b'\0\0\0\0'
            data = bytearray(await reader.readexactly(n))
            for i in range(n):
                data[i] ^= mask[i % 4]
            if op == 8:  # close
                return
            if op == 9:  # ping
                self.send_frame(writer, 10, bytes(data))
                continue
            if op in (0, 1):
                parts.append(bytes(data))
                if b0 & 0x80:
                    yield b''.join(parts).decode()
                    parts = []

    @staticmethod
    def send_frame(writer, op, data):
        n = len(data)
        head = bytes([0x80 | op]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack('>H', n) if n < 65536 else bytes([127]) + struct.pack('>Q', n))
        writer.write(head + data)

    # --- MCP over stdio (JSON-RPC 2.0, one message per line)

    def send(self, msg):
        self.out.write(json.dumps(msg).encode() + b'\n')
        self.out.flush()

    async def mcp(self):
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=64 * 1024 * 1024)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        while line := await reader.readline():
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                self.send({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'parse error'}})
                continue
            asyncio.create_task(self.handle(msg))
        log('stdin closed; stopping')

    async def handle(self, msg):
        mid, method, params = msg.get('id'), msg.get('method'), msg.get('params') or {}
        if mid is None:
            return  # a notification (notifications/initialized, cancelled, ...)
        try:
            if method == 'initialize':
                # Not at startup: Claude Code starts a server once just to probe it and closes it
                # before initialize; that one shouldn't open a window or lock the browser profile.
                self.start_browser()
                result = {
                    'protocolVersion': params.get('protocolVersion', PROTOCOL),
                    'capabilities': {'tools': {'listChanged': False}},
                    'serverInfo': {'name': 'rust-browser-ide', 'version': '0.1.0'},
                    'instructions': 'Rust projects that build, run and test inside a browser tab (rustc compiled to WebAssembly, '
                                    'target wasm32-wasip1). Create a project, edit files, then cargo_check / cargo_build / cargo_run / '
                                    'cargo_test / cargo_clippy / cargo_fmt. Dependencies come from crates.io (dependency_add). '
                                    'Programs run in a sandbox without network.',
                }
            elif method == 'tools/list':
                result = {'tools': [{k: t[k] for k in ('name', 'description', 'inputSchema')} for t in TOOLS]}
            elif method == 'tools/call':
                result = await self.call(params.get('name'), params.get('arguments') or {})
            elif method == 'ping':
                result = {}
            else:
                return self.send({'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': f'unknown method {method}'}})
            self.send({'jsonrpc': '2.0', 'id': mid, 'result': result})
        except Exception as e:  # noqa: BLE001 - any failure goes back to the agent
            self.send({'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32603, 'message': f'{type(e).__name__}: {e}'}})

    async def call(self, name, args):
        if name not in {t['name'] for t in TOOLS}:
            return {'content': [{'type': 'text', 'text': f'unknown tool {name}'}], 'isError': True}
        if not self.page_ready.is_set():
            self.start_browser()
            try:
                await asyncio.wait_for(self.page_ready.wait(), PAGE_WAIT)
            except TimeoutError:
                return {'content': [{'type': 'text', 'text': f'the IDE page is not connected: open {self.url} in Chromium'}], 'isError': True}
        self.next_id += 1
        cid = self.next_id
        fut = asyncio.get_running_loop().create_future()
        self.pending[cid] = fut
        t0 = time.monotonic()
        self.send_frame(self.page, 1, json.dumps({'type': 'call', 'id': cid, 'tool': name, 'args': args}).encode())
        await self.page.drain()
        try:
            m = await asyncio.wait_for(fut, CALL_TIMEOUT)
        except TimeoutError:
            self.pending.pop(cid, None)
            return {'content': [{'type': 'text', 'text': f'{name} took longer than {CALL_TIMEOUT} s'}], 'isError': True}
        log(f'{name} {"ok" if m["type"] == "result" else "error"} in {time.monotonic() - t0:.1f} s')
        if m['type'] == 'error':
            return {'content': [{'type': 'text', 'text': m.get('error', 'error')}], 'isError': True}
        return {'content': [{'type': 'text', 'text': json.dumps(m['result'], indent=1, ensure_ascii=False)}], 'isError': False}

    # --- the browser

    def start_browser(self):
        if self.browser_mode == 'none' or (self.browser and self.browser.poll() is None):
            return
        node = shutil.which('node')
        if not node:
            log(f'no node on PATH; open {self.url} in Chromium')
            return
        args = [node, str(Path(__file__).with_name('browser.mjs')), self.url, '--profile', str(self.profile)]
        if self.browser_mode == 'headless':
            args.append('--headless')
        log(f'starting Chromium ({self.browser_mode})')
        # Its stdin is a pipe from us: when the relay goes, however it goes, the browser follows
        # (an orphaned one would keep the profile locked and knock with a stale token).
        self.browser = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=sys.stderr, stderr=sys.stderr, cwd=REPO)


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=int(os.environ.get('RELAY_PORT', 8790)))
    ap.add_argument('--browser', choices=['headed', 'headless', 'none'], default=os.environ.get('RELAY_BROWSER', 'headed'))
    # One Chromium per profile: tests use their own, so they can run next to an open session.
    ap.add_argument('--profile', default=os.environ.get('RELAY_PROFILE', str(REPO / 'build/relay/profile')))
    # The IDE without an agent (`pnpm ide`): no MCP on stdin; runs until Ctrl-C.
    ap.add_argument('--no-mcp', action='store_true')
    a = ap.parse_args()
    if not (APP / 'ide.html').is_file():
        log(f'no {APP / "ide.html"}: run `pnpm build:app` first')
        sys.exit(1)
    relay = Relay(a.port, a.browser, Path(a.profile).resolve())
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    try:
        server = await asyncio.start_server(relay.serve, '127.0.0.1', a.port)
    except OSError as e:
        # The port is taken (another relay, or one still shutting down): any free port works,
        # since the page's URL comes from here.
        server = await asyncio.start_server(relay.serve, '127.0.0.1', 0)
        relay.port = server.sockets[0].getsockname()[1]
        relay.origin = f'http://127.0.0.1:{relay.port}'
        log(f'port {a.port} is in use ({e.strerror}); using {relay.port}. Projects are stored per origin, '
            f'so this page sees other projects than the one on port {a.port}')
    log(f'serving {relay.origin}; the IDE page: {relay.url}')
    (REPO / 'build/relay').mkdir(parents=True, exist_ok=True)
    (REPO / 'build/relay/url.txt').write_text(relay.url + '\n')
    try:
        if a.no_mcp:
            relay.start_browser()
            log('no MCP (--no-mcp): the IDE alone; Ctrl-C stops it')
            await stop.wait()
            return
        mcp = asyncio.ensure_future(relay.mcp())
        await asyncio.wait([mcp, asyncio.ensure_future(stop.wait())], return_when=asyncio.FIRST_COMPLETED)
    finally:
        server.close()
        if relay.browser and relay.browser.poll() is None:
            relay.browser.terminate()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
