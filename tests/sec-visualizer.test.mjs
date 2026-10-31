/**
 * SEC-6 (MEDIUM): the visualizer is local only.
 *
 * Before the fix the HTTP server and the WebSocket server listened on every
 * interface, every HTTP answer carried `Access-Control-Allow-Origin: *`, and
 * neither server looked at the Host or the Origin header. A web page in the
 * user's browser (or any machine on the network) could read the dependency
 * graph and the task description.
 *
 * After the fix:
 *   - both servers bind to 127.0.0.1 only;
 *   - no answer carries a CORS header, and OPTIONS gets no special answer;
 *   - every HTTP request needs Host `127.0.0.1:<httpPort>` or
 *     `localhost:<httpPort>` (this stops DNS rebinding);
 *   - a WebSocket upgrade with an Origin header needs Origin
 *     `http://127.0.0.1:<httpPort>` or `http://localhost:<httpPort>`;
 *   - a WebSocket upgrade without an Origin header is accepted: a local process
 *     that is not a browser can already read the project.
 *
 * There is no token. It would add friction and the two checks cover browsers.
 * Other users on a shared machine are not covered (see SECURITY.md).
 *
 * Network rules of this file: every connection goes to 127.0.0.1 or ::1, with
 * one exception. The bind test also connects to the non-loopback addresses
 * that belong to this machine (taken from os.networkInterfaces()). The
 * operating system delivers such a connection locally, so no packet leaves the
 * machine. The test expects it to be refused. All ports are free ports that the
 * test asks the operating system for.
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-visualizer.test.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { after, before, describe, it } from 'node:test';

import WebSocket from 'ws';

const { VisualizerServer } = await import('../dist/visualizer/visualizer-server.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** n distinct free ports on 127.0.0.1, all held open at once so they differ. */
async function freePorts(n) {
  const servers = [];
  const ports = [];
  try {
    for (let i = 0; i < n; i++) {
      const s = net.createServer();
      await new Promise((resolve, reject) => {
        s.once('error', reject);
        s.listen(0, '127.0.0.1', resolve);
      });
      servers.push(s);
      ports.push(s.address().port);
    }
  } finally {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  }
  return ports;
}

/** Start a VisualizerServer on two free ports. Retries if a port was taken in between. */
async function startServer() {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const [httpPort, wsPort] = await freePorts(2);
    const server = new VisualizerServer({ httpPort, wsPort });
    try {
      await server.start();
      return { server, httpPort, wsPort };
    } catch (err) {
      lastError = err;
      // start() does not undo a half start; close what it opened.
      try { server['httpServer']?.close(); } catch { /* ignore */ }
      try { server['wss']?.close(); } catch { /* ignore */ }
      if (err?.code !== 'EADDRINUSE') throw err;
    }
  }
  throw lastError;
}

/**
 * One HTTP request to 127.0.0.1:<port>. `host`, when given, replaces the Host
 * header. fetch() cannot do that, so this uses node:http.
 */
function request({ port, method = 'GET', path = '/', host, headers = {} }) {
  return new Promise((resolve, reject) => {
    const hdrs = { ...headers };
    if (host !== undefined) hdrs.Host = host;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: hdrs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`request timeout: ${method} ${path} Host=${host}`)));
    req.end();
  });
}

/** TCP connect. Resolves { connected: true } or { connected: false, code }. */
function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (r) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(3000, () => finish({ connected: false, code: 'TIMEOUT' }));
    socket.once('connect', () => finish({ connected: true }));
    socket.once('error', (err) => finish({ connected: false, code: err.code || err.message }));
  });
}

/**
 * Open a WebSocket. `origin` undefined means no Origin header at all.
 * Resolves { opened: true, ws } or { opened: false, status?, error? }.
 */
function wsAttempt(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { origin });
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!r.opened) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
      resolve(r);
    };
    const timer = setTimeout(() => done({ opened: false, error: 'timeout' }), 5000);
    ws.on('open', () => done({ opened: true, ws }));
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      done({ opened: false, status: res.statusCode });
    });
    ws.on('error', (err) => done({ opened: false, error: err.message }));
  });
}

/** Send a ping on an open socket and wait for the pong. */
function pingPong(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no pong within 5 s')), 5000);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'pong') {
        clearTimeout(timer);
        resolve(msg);
      }
    });
    ws.send(JSON.stringify({ type: 'ping', payload: {}, timestamp: Date.now() }));
  });
}

/** Addresses of this machine that are not loopback and not link-local IPv6. */
function nonLoopbackAddresses() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      if (a.family === 'IPv6' && a.address.toLowerCase().startsWith('fe80:')) continue;
      out.push(a.address);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SEC-6: visualizer is local only', () => {
  let ctx;

  before(async () => {
    ctx = await startServer();
  });

  after(async () => {
    if (ctx?.server) await ctx.server.stop();
  });

  it('HTTP and WebSocket bind only to 127.0.0.1', async (t) => {
    const { server, httpPort, wsPort } = ctx;

    // The socket the operating system really bound.
    const httpAddr = server['httpServer'].address();
    const wsAddr = server['wss'].address();
    assert.equal(httpAddr.address, '127.0.0.1', `HTTP server bound to ${JSON.stringify(httpAddr)}`);
    assert.equal(wsAddr.address, '127.0.0.1', `WebSocket server bound to ${JSON.stringify(wsAddr)}`);

    // Control: the loopback address works, so a refusal below means something.
    assert.deepEqual(await tcpProbe('127.0.0.1', httpPort), { connected: true });
    assert.deepEqual(await tcpProbe('127.0.0.1', wsPort), { connected: true });

    // IPv6 loopback must be refused too: a server bound to :: would take it.
    for (const port of [httpPort, wsPort]) {
      const r = await tcpProbe('::1', port);
      assert.equal(r.connected, false, `::1:${port} accepted a connection`);
    }

    // The other addresses of this machine. Local delivery only (see header).
    const others = nonLoopbackAddresses();
    if (others.length === 0) {
      t.diagnostic('no non-loopback address on this machine; only the bound address and ::1 were checked');
    }
    for (const address of others) {
      for (const port of [httpPort, wsPort]) {
        const r = await tcpProbe(address, port);
        assert.equal(r.connected, false, `${address}:${port} accepted a connection`);
      }
    }
  });

  it('no Access-Control-Allow-Origin on any response', async () => {
    const { httpPort } = ctx;
    const foreign = 'http://evil.example';
    const probes = [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/index.html' },
      { method: 'GET', path: '/api/health' },
      { method: 'GET', path: '/api/graph' },
      { method: 'GET', path: '/does-not-exist' },
      { method: 'GET', path: '/api/health', headers: { Origin: foreign } },
      { method: 'OPTIONS', path: '/' },
      { method: 'OPTIONS', path: '/api/graph', headers: { Origin: foreign, 'Access-Control-Request-Method': 'GET' } },
      { method: 'POST', path: '/api/graph', headers: { Origin: foreign } },
      // A refused request is a response as well.
      { method: 'GET', path: '/api/graph', host: 'evil.example' },
    ];
    for (const p of probes) {
      const res = await request({ port: httpPort, ...p });
      const label = `${p.method} ${p.path}${p.host ? ` Host=${p.host}` : ''}`;
      const cors = Object.keys(res.headers).filter((k) => k.startsWith('access-control-'));
      assert.deepEqual(cors, [], `${label} (status ${res.status}) carries CORS headers: ${cors.join(', ')}`);
    }

    // No blanket answer for OPTIONS any more: it is routed like every other
    // request. The handler has no method check, so on a known path (/, /api/...)
    // it gets that path's answer, still without CORS headers (checked above);
    // on an unknown path it gets 404.
    const options = await request({ port: httpPort, method: 'OPTIONS', path: '/does-not-exist' });
    assert.equal(options.status, 404, 'OPTIONS on an unknown path must fall through to 404');
  });

  it('GET with a foreign Host gets 403', async () => {
    const { httpPort, wsPort } = ctx;

    // Control: the two allowed Host values still work, in any letter case for the name.
    for (const host of [`127.0.0.1:${httpPort}`, `localhost:${httpPort}`, `LOCALHOST:${httpPort}`]) {
      const ok = await request({ port: httpPort, path: '/api/health', host });
      assert.equal(ok.status, 200, `Host ${host} must be allowed (got ${ok.status})`);
      const page = await request({ port: httpPort, path: '/', host });
      assert.equal(page.status, 200, `GET / with Host ${host} must be allowed (got ${page.status})`);
    }

    const foreignHosts = [
      'evil.example',
      `evil.example:${httpPort}`,
      `127.0.0.1.evil.example:${httpPort}`,
      `localhost.evil.example:${httpPort}`,
      `127.0.0.1:${wsPort}`, // right name, wrong port
      `localhost:${wsPort}`,
      '127.0.0.1', // no port
      `0.0.0.0:${httpPort}`,
    ];
    for (const host of foreignHosts) {
      for (const p of ['/', '/index.html', '/api/health', '/api/graph']) {
        const res = await request({ port: httpPort, path: p, host });
        assert.equal(res.status, 403, `GET ${p} with Host ${host} got ${res.status}, expected 403`);
        assert.ok(!res.body.includes('"nodes"') && !res.body.includes('<html'), `the 403 answer for ${host} still leaks content`);
      }
    }
  });

  it('WebSocket with a foreign Origin is rejected', async () => {
    const { httpPort, wsPort } = ctx;
    const url = `ws://127.0.0.1:${wsPort}`;
    const foreignOrigins = [
      'http://evil.example',
      `http://evil.example:${httpPort}`,
      `http://127.0.0.1.evil.example:${httpPort}`,
      `http://localhost.evil.example:${httpPort}`,
      `http://127.0.0.1:${wsPort}`, // right name, wrong port
      `https://127.0.0.1:${httpPort}`, // wrong scheme
      'null', // sandboxed frames and file: pages
    ];
    for (const origin of foreignOrigins) {
      const r = await wsAttempt(url, origin);
      if (r.opened) r.ws.terminate();
      assert.equal(r.opened, false, `Origin ${origin} was accepted`);
      assert.equal(r.status, 403, `Origin ${origin}: expected a 403 refusal, got ${JSON.stringify({ status: r.status, error: r.error })}`);
    }
  });

  it("WebSocket from the page's own origin connects", async () => {
    const { httpPort, wsPort } = ctx;
    const url = `ws://127.0.0.1:${wsPort}`;
    for (const origin of [`http://127.0.0.1:${httpPort}`, `http://localhost:${httpPort}`]) {
      const r = await wsAttempt(url, origin);
      assert.equal(r.opened, true, `Origin ${origin} was refused: ${JSON.stringify({ status: r.status, error: r.error })}`);
      try {
        const pong = await pingPong(r.ws);
        assert.equal(pong.type, 'pong');
      } finally {
        r.ws.terminate();
      }
    }

    // The page connects to the host name it was opened with, so the Origin the
    // browser sends and the address it connects to are the same pair.
    const page = await request({ port: httpPort, path: '/' });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes("'ws://' + location.hostname + ':' + WS_PORT"), 'the page must build the WebSocket URL from location.hostname');
    assert.ok(!page.body.includes("'ws://localhost:'"), 'the page must not hard-code ws://localhost');
  });

  it('WebSocket without Origin connects', async () => {
    // curl, scripts and other local tools send no Origin header. A local
    // process that is not a browser can already read the project directly.
    const { wsPort } = ctx;
    const r = await wsAttempt(`ws://127.0.0.1:${wsPort}`, undefined);
    assert.equal(r.opened, true, `a connection without Origin was refused: ${JSON.stringify({ status: r.status, error: r.error })}`);
    try {
      const pong = await pingPong(r.ws);
      assert.equal(pong.type, 'pong');
    } finally {
      r.ws.terminate();
    }
  });
});
