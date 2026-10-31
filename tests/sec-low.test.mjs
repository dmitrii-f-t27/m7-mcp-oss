/**
 * SEC-12 (LOW, other spot) the mesh relay, and SEC-10 (LOW) the Cursor installer.
 *
 * Relay (`src/mesh/relay/server.ts`), SEC-12
 * - It used to listen on every network interface by default. It now binds
 *   `M7_RELAY_HOST`, default `127.0.0.1`.
 * - It used to compare the bearer token with `===`. It now compares SHA-256
 *   digests with `crypto.timingSafeEqual`.
 *
 * Installer (`install.sh`, `scripts/merge-cursor-config.mjs`), SEC-10
 * - It used to replace `~/.cursor/mcp.json` and write the API keys into it in
 *   plain text. `scripts/merge-cursor-config.mjs` now adds the `m7` entry to
 *   the file, keeps every other entry, refuses a file it cannot parse, and
 *   writes no key (the server reads the `.env` in its install directory).
 *
 * What these tests do not prove, on purpose
 * - Timing cannot be tested honestly in a unit test: the difference between a
 *   plain compare and a constant-time compare is too small and too noisy to
 *   measure. The `timingSafeEqual` test is a static check of the source and of
 *   the build. It proves the call is present, not that the timing is flat.
 * - `install.sh` itself is not run here, because it installs packages and
 *   edits the user's real Cursor config. Only the merge script it calls is
 *   tested, against temporary files, with HOME pointed at a temporary directory.
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-low.test.mjs
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELAY_JS = path.join(REPO_ROOT, 'dist', 'mesh', 'relay', 'server.js');
const RELAY_TS = path.join(REPO_ROOT, 'src', 'mesh', 'relay', 'server.ts');
const MERGE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'merge-cursor-config.mjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let tmpRoot;
before(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'm7-sec-low-'));
});
after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeDir(name) {
  const dir = path.join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Relay helpers
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Start the real relay (`node dist/mesh/relay/server.js`) on a free port, with
 * a temporary data directory. `M7_RELAY_HOST` is removed from the child
 * environment unless the caller sets it, so an ambient value cannot change
 * what the default case tests.
 */
async function startRelay(extraEnv = {}) {
  const port = await freePort();
  const secret = `relay-secret-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const data = makeDir(`relay-data-${port}`);
  const env = { ...process.env, M7_RELAY_SECRET: secret, M7_RELAY_PORT: String(port), M7_RELAY_DATA_DIR: data, ...extraEnv };
  if (!('M7_RELAY_HOST' in extraEnv)) delete env.M7_RELAY_HOST;
  const child = spawn(process.execPath, [RELAY_JS], { cwd: data, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`relay exited early:\n${log}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`relay did not start:\n${log}`);
    }
    await sleep(50);
  }

  async function stop() {
    if (child.exitCode === null) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  return { port, url, secret, stop, log: () => log };
}

/** The first IPv4 address of this machine that is not loopback, or null. */
function firstExternalIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return null;
}

/** Try one TCP connection. Resolves with 'connected', or the error code, or 'timeout'. */
function tcpProbe(host, port, ms = 5000) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = result => { sock.destroy(); resolve(result); };
    sock.setTimeout(ms, () => done('timeout'));
    sock.once('connect', () => done('connected'));
    sock.once('error', err => done(err.code ?? String(err)));
  });
}

// ---------------------------------------------------------------------------
// Relay: bind address
// ---------------------------------------------------------------------------

const EXTERNAL_IP = firstExternalIPv4();

describe('SEC-12: the relay binds to loopback by default', () => {
  it('relay listens on loopback by default', {
    timeout: 60_000,
    skip: EXTERNAL_IP ? false : 'no non-internal IPv4 address on this machine',
  }, async () => {
    const relay = await startRelay();
    try {
      // Reachable on loopback: startRelay already needed it to see /health.
      const viaLoopback = await tcpProbe('127.0.0.1', relay.port);
      assert.equal(viaLoopback, 'connected', `the relay must answer on 127.0.0.1\n${relay.log()}`);

      // Not reachable through the machine's network address.
      const viaLan = await tcpProbe(EXTERNAL_IP, relay.port);
      assert.equal(
        viaLan,
        'ECONNREFUSED',
        `a connection to ${EXTERNAL_IP}:${relay.port} must be refused; got: ${viaLan}\n${relay.log()}`,
      );
    } finally {
      await relay.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Relay: bearer token compare
// ---------------------------------------------------------------------------

describe('SEC-12: relay bearer token', () => {
  it('relay token compare accepts only the exact token', { timeout: 60_000 }, async () => {
    const relay = await startRelay();
    try {
      const status = async authorization => {
        const headers = authorization === null ? {} : { Authorization: authorization };
        const res = await fetch(`${relay.url}/state`, { headers });
        await res.text();
        return res.status;
      };
      const s = relay.secret;

      assert.equal(await status(`Bearer ${s}`), 200, 'the exact token is accepted');

      const rejected = {
        'no header': null,
        'empty header': '',
        'token without the scheme': s,
        'lower-case scheme': `bearer ${s}`,
        'another scheme': `Basic ${s}`,
        'two spaces after the scheme': `Bearer  ${s}`,
        'token plus one character': `Bearer ${s}x`,
        'token minus one character': `Bearer ${s.slice(0, -1)}`,
        'same length, last character changed': `Bearer ${s.slice(0, -1)}${s.endsWith('a') ? 'b' : 'a'}`,
        'upper-cased token': `Bearer ${s.toUpperCase()}`,
        'a very long token': `Bearer ${'a'.repeat(8000)}`,
        'a different token': 'Bearer not-the-relay-secret',
        'scheme only': 'Bearer ',
      };
      for (const [what, header] of Object.entries(rejected)) {
        assert.equal(await status(header), 401, `${what} must be refused`);
      }

      // The health route stays open, as before.
      const health = await fetch(`${relay.url}/health`);
      assert.equal(health.status, 200);
      await health.text();
    } finally {
      await relay.stop();
    }
  });

  it('relay token compare uses timingSafeEqual (static check; timing is not measured)', () => {
    // A timing difference of one string compare cannot be measured honestly in
    // a unit test. This only proves the constant-time call is in the source
    // and in the build, and that the plain `===` compare of the header is gone.
    for (const file of [RELAY_TS, RELAY_JS]) {
      const text = readFileSync(file, 'utf8');
      // assert.ok, not assert.match: a failed match would print the whole file.
      assert.ok(/timingSafeEqual\(/.test(text), `${file} must call crypto.timingSafeEqual`);
      assert.ok(/sha256/.test(text), `${file} must compare SHA-256 digests, so both buffers have the same length`);
      const plainCompare = text.split('\n').filter(line => /Bearer/.test(line) && /[!=]==?\s/.test(line));
      assert.deepEqual(plainCompare, [], `${file} must not compare the bearer header with == or ===`);
    }
  });
});

// ---------------------------------------------------------------------------
// merge-cursor-config
// ---------------------------------------------------------------------------

/**
 * Run `node scripts/merge-cursor-config.mjs <config> <install dir>`.
 * HOME and USERPROFILE point at a throwaway directory so that even a script
 * that fell back to `~/.cursor/mcp.json` could not touch the real file. The
 * keys in the child environment are canaries: they must never be written.
 */
function runMerge(configPath, installDir, { env = {} } = {}) {
  const fakeHome = makeDir(`home-${Math.random().toString(36).slice(2)}`);
  const res = spawnSync(process.execPath, [MERGE_SCRIPT, configPath, installDir], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      OPENAI_API_KEY: 'sk-canary-openai-from-process-env',
      ANTHROPIC_API_KEY: 'sk-ant-canary-anthropic-from-process-env',
      ...env,
    },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const OTHER_SERVER = { command: 'npx', args: ['-y', 'some-other-mcp'], env: { SOME_TOKEN: 'belongs-to-the-other-server' } };

function seedConfig(dirName, content) {
  const dir = makeDir(dirName);
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return { dir, file };
}

describe('SEC-10: scripts/merge-cursor-config.mjs', () => {
  it('merge-cursor-config keeps other servers', () => {
    const installDir = makeDir('install-keep');

    // m7 not in the file yet: the other server and the other top-level key stay.
    const a = seedConfig('cfg-add', { mcpServers: { other: OTHER_SERVER }, theme: { dark: true } });
    const resA = runMerge(a.file, installDir);
    assert.equal(resA.code, 0, `merge must succeed\nstdout: ${resA.stdout}\nstderr: ${resA.stderr}`);
    const afterA = JSON.parse(readFileSync(a.file, 'utf8'));
    assert.deepEqual(afterA.mcpServers.other, OTHER_SERVER, 'the other server must be unchanged');
    assert.deepEqual(afterA.theme, { dark: true }, 'other top-level keys must be unchanged');
    assert.equal(afterA.mcpServers.m7.command, 'node');
    assert.deepEqual(afterA.mcpServers.m7.args, [path.join(installDir, 'dist', 'index.js')]);
    assert.equal(afterA.mcpServers.m7.cwd, installDir);

    // m7 already in the file with old content: only that entry is replaced.
    const b = seedConfig('cfg-replace', {
      mcpServers: {
        other: OTHER_SERVER,
        m7: { command: 'old', args: ['/old/dist/index.js'], env: { OLD_ONLY: '1' } },
        third: { url: 'http://127.0.0.1:9999/mcp' },
      },
    });
    const resB = runMerge(b.file, installDir);
    assert.equal(resB.code, 0, `merge must succeed\nstdout: ${resB.stdout}\nstderr: ${resB.stderr}`);
    const afterB = JSON.parse(readFileSync(b.file, 'utf8'));
    assert.deepEqual(afterB.mcpServers.other, OTHER_SERVER);
    assert.deepEqual(afterB.mcpServers.third, { url: 'http://127.0.0.1:9999/mcp' });
    assert.equal(afterB.mcpServers.m7.command, 'node');
    assert.deepEqual(afterB.mcpServers.m7.args, [path.join(installDir, 'dist', 'index.js')]);
    assert.equal(afterB.mcpServers.m7.env?.OLD_ONLY, undefined, 'the old m7 entry is replaced, not extended');

    // No file yet (and no directory yet): the file is created with the m7 entry.
    const fresh = path.join(makeDir('cfg-fresh'), 'nested', 'mcp.json');
    const resC = runMerge(fresh, installDir);
    assert.equal(resC.code, 0, `merge must succeed\nstdout: ${resC.stdout}\nstderr: ${resC.stderr}`);
    const afterC = JSON.parse(readFileSync(fresh, 'utf8'));
    assert.deepEqual(Object.keys(afterC.mcpServers), ['m7']);
  });

  it('merge-cursor-config refuses invalid JSON and leaves the file alone', () => {
    const installDir = makeDir('install-invalid');
    const cases = {
      'truncated JSON': '{ "mcpServers": { "other": { "command": "npx"',
      'not JSON at all': 'this is not json\n',
      'empty file': '',
      'JSON that is not an object': '[1, 2, 3]',
      'mcpServers that is not an object': '{ "mcpServers": ["m7"] }',
    };
    for (const [what, text] of Object.entries(cases)) {
      const { dir, file } = seedConfig(`cfg-invalid-${Object.keys(cases).indexOf(what)}`, text);
      const res = runMerge(file, installDir);
      // Exit code 2 is the script's "refused" code. A missing script or a
      // crash exits with 1, so they cannot pass for a refusal.
      assert.equal(res.code, 2, `${what}: merge must refuse with exit code 2\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
      assert.ok(res.stderr.includes(file), `${what}: the reason must go to stderr and name the file\nstderr: ${res.stderr}`);
      assert.equal(readFileSync(file, 'utf8'), text, `${what}: the file must be byte-for-byte unchanged`);
      assert.deepEqual(readdirSync(dir), ['mcp.json'], `${what}: no temporary or backup file may be left behind`);
    }
  });

  it('merge-cursor-config writes no key', () => {
    // The install directory has a .env with a key, and the process environment
    // has keys too. None of them may reach mcp.json: the server reads the
    // .env in its install directory by itself.
    const installDir = makeDir('install-nokey');
    writeFileSync(path.join(installDir, '.env'), 'OPENAI_API_KEY=sk-canary-openai-from-dotenv\nANTHROPIC_API_KEY=sk-ant-canary-from-dotenv\n');
    const { file } = seedConfig('cfg-nokey', { mcpServers: { other: OTHER_SERVER } });

    const res = runMerge(file, installDir);
    assert.equal(res.code, 0, `merge must succeed\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);

    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /canary/, 'no key value may be written');
    assert.doesNotMatch(text, /sk-/, 'nothing that looks like a key may be written');
    const entry = JSON.parse(text).mcpServers.m7;
    assert.ok(entry, 'the m7 entry must exist');
    for (const name of Object.keys(entry.env ?? {})) {
      assert.doesNotMatch(name, /KEY|TOKEN|SECRET|PASSWORD/i, `env name ${name} looks like a credential`);
    }
    // The other server keeps its own env, even though it holds a "token".
    assert.equal(JSON.parse(text).mcpServers.other.env.SOME_TOKEN, 'belongs-to-the-other-server');
  });
});
