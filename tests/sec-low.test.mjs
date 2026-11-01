// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
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
 * - It also keeps the saved `env` of the old `m7` entry (only `OPENAI_API_KEY`
 *   and `ANTHROPIC_API_KEY` are dropped), creates its temporary file private
 *   (mode 600), and refuses a dangling symlink instead of replacing it with a
 *   regular file.
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
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    // CHANGED on purpose. This line used to assert `OLD_ONLY === undefined`, which pinned
    // a bug: the installer wiped the saved `env` of the old m7 entry, so a saved
    // M7_PROJECT_PATH or M7_MESH_* variable disappeared. The saved env is now kept.
    // command, args and cwd are still replaced (asserted above); only env survives.
    assert.equal(afterB.mcpServers.m7.env?.OLD_ONLY, '1', 'the saved env of the old m7 entry is kept');

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

  it('merge-cursor-config keeps the saved m7 env and drops only the two API keys', () => {
    const installDir = makeDir('install-env');
    const saved = {
      M7_PROJECT_PATH: '/home/me/the-project',
      M7_MESH_RELAY: 'http://127.0.0.1:8787',
      M7_MESH_SECRET: 'mesh-secret-the-user-saved',
      M7_DEBUG: 'true',
    };
    const keys = {
      OPENAI_API_KEY: 'sk-canary-openai-in-old-entry',
      ANTHROPIC_API_KEY: 'sk-ant-canary-anthropic-in-old-entry',
    };
    const { file } = seedConfig('cfg-env', {
      mcpServers: { other: OTHER_SERVER, m7: { command: 'old', args: ['/old/dist/index.js'], env: { ...saved, ...keys } } },
    });

    const res = runMerge(file, installDir);
    assert.equal(res.code, 0, `merge must succeed\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);

    const text = readFileSync(file, 'utf8');
    const entry = JSON.parse(text).mcpServers.m7;
    assert.deepEqual(entry.env, saved, 'the saved variables stay, the two API keys go');
    assert.doesNotMatch(text, /canary/, 'no API key value may be written');
    assert.equal(entry.command, 'node');
    assert.deepEqual(entry.args, [path.join(installDir, 'dist', 'index.js')]);
    assert.equal(entry.cwd, installDir);
    assert.deepEqual(JSON.parse(text).mcpServers.other, OTHER_SERVER, 'the other server is unchanged');
  });

  it('merge-cursor-config writes no env block when nothing is left after dropping the keys', () => {
    const installDir = makeDir('install-env-empty');
    const odd = {
      'only the two keys': { OPENAI_API_KEY: 'sk-canary-1', ANTHROPIC_API_KEY: 'sk-ant-canary-2' },
      'an empty env': {},
      'env that is not an object (string)': 'OPENAI_API_KEY=sk-canary-3',
      'env that is not an object (array)': ['sk-canary-4'],
      'env that is null': null,
    };
    for (const [what, env] of Object.entries(odd)) {
      const { file } = seedConfig(`cfg-env-odd-${Object.keys(odd).indexOf(what)}`, { mcpServers: { m7: { command: 'old', env } } });
      const res = runMerge(file, installDir);
      assert.equal(res.code, 0, `${what}: merge must succeed\nstderr: ${res.stderr}`);
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /canary/, `${what}: no key value may be written`);
      assert.equal('env' in JSON.parse(text).mcpServers.m7, false, `${what}: the m7 entry must have no env block`);
    }
  });

  it('merge-cursor-config refuses a dangling symlink and leaves it alone', () => {
    const installDir = makeDir('install-dangling');
    const dir = makeDir('cfg-dangling');
    const missingTarget = path.join(dir, 'no-such-dir', 'real-mcp.json');

    const dangling = path.join(dir, 'mcp.json');
    symlinkSync(missingTarget, dangling);
    const loopA = path.join(dir, 'loop-a.json');
    const loopB = path.join(dir, 'loop-b.json');
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);

    for (const [what, file, target] of [['dangling link', dangling, missingTarget], ['link loop', loopA, loopB]]) {
      const res = runMerge(file, installDir);
      assert.equal(res.code, 2, `${what}: merge must refuse with exit code 2\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
      assert.ok(res.stderr.includes(file), `${what}: the reason must go to stderr and name the file\nstderr: ${res.stderr}`);
      assert.ok(lstatSync(file).isSymbolicLink(), `${what}: the symlink was replaced`);
      assert.equal(readlinkSync(file), target, `${what}: the symlink now points elsewhere`);
    }
    assert.equal(existsSync(path.dirname(missingTarget)), false, 'the script created the directory behind the dangling link');
    assert.deepEqual(readdirSync(dir).sort(), ['loop-a.json', 'loop-b.json', 'mcp.json'], 'no temporary or extra file may be left behind');
  });

  it('merge-cursor-config writes through a working symlink and keeps the link', () => {
    // Control for the dangling-link refusal: a dotfiles manager links mcp.json to a real file.
    const installDir = makeDir('install-link-ok');
    const dir = makeDir('cfg-link-ok');
    const real = path.join(dir, 'real-mcp.json');
    writeFileSync(real, JSON.stringify({ mcpServers: { other: OTHER_SERVER } }, null, 2));
    const link = path.join(dir, 'mcp.json');
    symlinkSync(real, link);

    const res = runMerge(link, installDir);
    assert.equal(res.code, 0, `merge must succeed\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.ok(lstatSync(link).isSymbolicLink(), 'the symlink was replaced by a regular file');
    assert.equal(readlinkSync(link), real);
    const merged = JSON.parse(readFileSync(real, 'utf8'));
    assert.deepEqual(merged.mcpServers.other, OTHER_SERVER);
    assert.equal(merged.mcpServers.m7.cwd, installDir);
    assert.deepEqual(readdirSync(dir).sort(), ['mcp.json', 'real-mcp.json']);
  });

  it('merge-cursor-config creates its temporary file private, and keeps the mode of the old file', () => {
    // The temporary file holds the whole mcp.json, which often carries other servers' keys.
    // It must never be readable by others, not even for the moment before the final mode is
    // applied. A preload wraps fs.writeFileSync, sets umask 0 (so a missing mode shows up as
    // 666) and records the real mode of the temporary file right after it is written.
    const installDir = makeDir('install-mode');
    const probeDir = makeDir('mode-probe');
    const probe = path.join(probeDir, 'probe.cjs');
    const log = path.join(probeDir, 'modes.log');
    writeFileSync(probe, [
      "const fs = require('node:fs');",
      "const { syncBuiltinESMExports } = require('node:module');",
      'process.umask(0);',
      'const real = fs.writeFileSync;',
      'fs.writeFileSync = function (file, ...rest) {',
      '  const result = real.call(this, file, ...rest);',
      "  if (String(file).includes('.m7-tmp-')) {",
      "    fs.appendFileSync(process.env.M7_TEST_MODE_LOG, (fs.statSync(file).mode & 0o777).toString(8) + '\\n');",
      '  }',
      '  return result;',
      '};',
      'syncBuiltinESMExports();',
      '',
    ].join('\n'));

    const runProbed = file => spawnSync(process.execPath, ['--require', probe, MERGE_SCRIPT, file, installDir], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: probeDir, USERPROFILE: probeDir, M7_TEST_MODE_LOG: log },
    });

    // An existing file with mode 640: the final file keeps 640.
    const existing = seedConfig('cfg-mode-existing', { mcpServers: { other: OTHER_SERVER } });
    chmodSync(existing.file, 0o640);
    const resA = runProbed(existing.file);
    assert.equal(resA.status, 0, `merge must succeed\nstdout: ${resA.stdout}\nstderr: ${resA.stderr}`);
    assert.equal(statSync(existing.file).mode & 0o777, 0o640, 'the mode of the old file must be kept');

    // A new file: created private.
    const fresh = path.join(makeDir('cfg-mode-new'), 'mcp.json');
    const resB = runProbed(fresh);
    assert.equal(resB.status, 0, `merge must succeed\nstdout: ${resB.stdout}\nstderr: ${resB.stderr}`);

    // The probe saw both temporary files, and each was private when it was written.
    const seen = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    assert.equal(seen.length, 2, `the probe must see both temporary files; saw: ${JSON.stringify(seen)}\n${resA.stderr}${resB.stderr}`);
    assert.deepEqual(seen, ['600', '600'], 'the temporary file was created with a mode other than 600');

    assert.equal(statSync(fresh).mode & 0o777, 0o600, 'a new config file must not be readable by others');
  });
});

// ---------------------------------------------------------------------------
// SEC-27: the console monitor follows the journal of the current project
// ---------------------------------------------------------------------------

// `ConsoleMonitor` is one object per process. It took the journal of the first caller and
// kept it, so after the server moved to another project (a Roots change, or an explicit
// project_path) the errors it captured went to the journal of the old project. The tool is
// the way in: every call passes the journal of the moment, and the monitor must use it.

describe('SEC-27: ConsoleMonitor uses the journal of the latest call', () => {
  it('a console error captured after a second call reaches the second journal, not the first', async () => {
    const { consoleTool } = await import(pathToFileURL(path.join(REPO_ROOT, 'dist', 'core', 'tools', 'critical', 'console.js')).href);
    const makeJournal = () => {
      const errors = [];
      return { errors, logError: entry => { errors.push(entry); return Promise.resolve('id'); }, logFeature: () => Promise.resolve('id') };
    };
    const j1 = makeJournal();
    const j2 = makeJournal();

    // Silence the real console while the monitor wraps it: the monitor remembers this stub as the original.
    const realError = console.error;
    console.error = () => {};
    try {
      await consoleTool.handler({ action: 'start' }, { journal: j1 });
      console.error('sec-27 first error, project one');
      assert.equal(j1.errors.length, 1, 'control: the first journal must get the first error');

      await consoleTool.handler({ action: 'status' }, { journal: j2 });
      console.error('sec-27 second error, project two');

      assert.equal(j1.errors.length, 1, 'the first journal got an error after the project changed');
      assert.equal(j2.errors.length, 1, 'the second journal got no error: the monitor kept the first journal');
      assert.match(j2.errors[0].error, /sec-27 second error/);
      await consoleTool.handler({ action: 'stop' }, { journal: j2 });
    } finally {
      console.error = realError;
    }
  });
});
