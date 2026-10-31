/**
 * SEC-8 (MEDIUM): `.env` is read from the install directory only.
 *
 * Before the fix `src/index.ts` called `dotenv.config()` with no path, so the
 * server loaded `.env` from its working directory. An MCP client starts the
 * server with whatever working directory the user configured, so a `.env` in an
 * untrusted project folder could supply the API keys and every other variable
 * the server reads (`M7_MESH_RELAY`, `M7_TELEMETRY_ENDPOINT`, `CHROMA_URL`,
 * `M7_ALLOW_REMOTE_CLASSIFICATION`, ...).
 *
 * After the fix the server reads one file: `.env` in its install directory, the
 * parent of `dist/`. The process environment still wins over that file.
 *
 * The server entry point must call `loadInstallEnv(import.meta.url)`. The
 * functions are tested on their own below, which would still pass if that call
 * were deleted from `src/index.ts`. The wiring test starts `dist/index.js` from a
 * temporary install tree, so the call is exercised end to end.
 *
 * Network rules of this file: nothing leaves the machine. The child server gets
 * placeholder keys only from the test's own `.env` text, and its OpenAI and
 * Anthropic base URLs point to a stub on 127.0.0.1. A real `.env` is never
 * created in the repository: the install-directory case runs against a
 * temporary directory that stands in for the install directory.
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-env.test.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

// A real .env in the install directory would be loaded by the fixed server and
// would hide the case under test. Say so instead of failing for the wrong reason.
const REPO_ENV_PRESENT = existsSync(path.join(REPO_ROOT, '.env'));
const SKIP_MESSAGE = `${path.join(REPO_ROOT, '.env')} exists: the server would load it, so the working-directory case cannot be tested`;

const PLACEHOLDER_OPENAI = 'placeholder-openai-key-from-env-file';
const PLACEHOLDER_ANTHROPIC = 'placeholder-anthropic-key-from-env-file';
const ENV_FILE_TEXT = `OPENAI_API_KEY=${PLACEHOLDER_OPENAI}\nANTHROPIC_API_KEY=${PLACEHOLDER_ANTHROPIC}\n`;

// How long the server may take to refuse to start. A server that is still
// alive after this had its keys from somewhere.
const EXIT_WAIT_MS = 20000;

let tmpRoot;
let stub;
let stubUrl;
const stubHits = [];

before(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'm7-sec-env-'));
  // Stub for the OpenAI and Anthropic SDKs. It refuses everything with 401 so
  // the SDKs do not retry, and it records what it was asked.
  stub = http.createServer((req, res) => {
    stubHits.push(`${req.method} ${req.url}`);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"authentication_error","message":"stub"}}');
  });
  await new Promise((resolve, reject) => {
    stub.once('error', reject);
    stub.listen(0, '127.0.0.1', resolve);
  });
  stubUrl = `http://127.0.0.1:${stub.address().port}`;
});

after(async () => {
  await new Promise((resolve) => stub.close(resolve));
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A fresh empty directory under the temp root. */
function makeDir(name) {
  const dir = path.join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Start dist/index.js with the given working directory and resolve when it
 * exits, or after `timeoutMs` (then it is killed and `timedOut` is true).
 * The child gets a minimal environment: neither API key, a project path inside
 * the temp root (so nothing is written to the repository), M7_DEBUG so the
 * fatal error reaches stderr, and base URLs that point to the local stub.
 */
function runServer({ cwd, timeoutMs = EXIT_WAIT_MS }) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: cwd,
    TMPDIR: cwd,
    CURSOR_WORKSPACE: cwd,
    M7_PROJECT_PATH: cwd,
    M7_DEBUG: 'true',
    OPENAI_BASE_URL: `${stubUrl}/v1`,
    ANTHROPIC_BASE_URL: stubUrl,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// The server process: a .env in the working directory is not loaded
// ---------------------------------------------------------------------------

describe('SEC-8: the working directory', () => {
  it(
    'a .env in the working directory is not loaded',
    { skip: REPO_ENV_PRESENT ? SKIP_MESSAGE : false },
    async () => {
      const cwd = makeDir('cwd-with-env');
      writeFileSync(path.join(cwd, '.env'), ENV_FILE_TEXT);

      const hitsBefore = stubHits.length;
      const result = await runServer({ cwd });

      assert.equal(
        result.timedOut,
        false,
        'the server kept running without keys in its environment: it loaded the .env from its working directory\n' +
          `stderr tail: ${result.stderr.slice(-400)}`,
      );
      assert.ok(result.code !== 0 && result.code !== null, `expected a non-zero exit, got code=${result.code} signal=${result.signal}`);
      assert.match(result.stderr, /required/, `stderr tail: ${result.stderr.slice(-400)}`);
      assert.equal(stubHits.length, hitsBefore, 'a server that refused to start must not call the API stub');
    },
  );
});

// ---------------------------------------------------------------------------
// The install directory: resolveInstallEnvPath and loadInstallEnv
// ---------------------------------------------------------------------------

describe('SEC-8: the install directory', () => {
  /** A temporary directory that stands in for the install directory. */
  function fakeInstall(name, envText) {
    const installDir = makeDir(name);
    mkdirSync(path.join(installDir, 'dist'), { recursive: true });
    if (envText !== undefined) writeFileSync(path.join(installDir, '.env'), envText);
    return {
      installDir,
      entryUrl: pathToFileURL(path.join(installDir, 'dist', 'index.js')).href,
    };
  }

  it('a .env in the install directory is loaded', async () => {
    const { resolveInstallEnvPath, loadInstallEnv } = await import('../dist/core/utils/loadEnv.js');
    const { installDir, entryUrl } = fakeInstall('install-with-env', ENV_FILE_TEXT);

    assert.equal(resolveInstallEnvPath(entryUrl), path.join(installDir, '.env'));

    const target = {};
    loadInstallEnv(entryUrl, target);
    assert.equal(target.OPENAI_API_KEY, PLACEHOLDER_OPENAI);
    assert.equal(target.ANTHROPIC_API_KEY, PLACEHOLDER_ANTHROPIC);
  });

  it('the process environment wins over the install-directory .env', async () => {
    const { loadInstallEnv } = await import('../dist/core/utils/loadEnv.js');
    const { entryUrl } = fakeInstall('install-env-loses', ENV_FILE_TEXT);

    const target = { OPENAI_API_KEY: 'from-the-process-environment' };
    loadInstallEnv(entryUrl, target);
    assert.equal(target.OPENAI_API_KEY, 'from-the-process-environment');
    assert.equal(target.ANTHROPIC_API_KEY, PLACEHOLDER_ANTHROPIC);
  });

  it('a missing install-directory .env is not an error', async () => {
    const { loadInstallEnv } = await import('../dist/core/utils/loadEnv.js');
    const { entryUrl } = fakeInstall('install-without-env');

    const target = { KEEP: 'yes' };
    assert.doesNotThrow(() => loadInstallEnv(entryUrl, target));
    assert.deepEqual(target, { KEEP: 'yes' });
  });
});

// ---------------------------------------------------------------------------
// The wiring: dist/index.js calls loadInstallEnv for its own install directory
// ---------------------------------------------------------------------------

describe('SEC-8: the entry point reads the install-directory .env', () => {
  it('a server started from an install tree gets its keys from that tree\'s .env', { timeout: 60_000 }, async () => {
    // A temporary install directory holds the .env and symlinks to the built server and its
    // dependencies. Node is started with --preserve-symlinks-main, so `import.meta.url` of
    // dist/index.js is the path inside this tree (not the real dist/ of the repository), and
    // the .env next to it is the only place the keys can come from: the child environment
    // has no key, and its working directory is another empty directory.
    const installDir = makeDir('wired-install');
    symlinkSync(path.join(REPO_ROOT, 'dist'), path.join(installDir, 'dist'), 'dir');
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(installDir, 'node_modules'), 'dir');
    symlinkSync(path.join(REPO_ROOT, 'package.json'), path.join(installDir, 'package.json'), 'file'); // "type": "module"
    writeFileSync(path.join(installDir, '.env'), ENV_FILE_TEXT);
    const cwd = makeDir('wired-cwd');

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--preserve-symlinks', '--preserve-symlinks-main', path.join(installDir, 'dist', 'index.js')],
      cwd,
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: cwd,
        TMPDIR: cwd,
        CURSOR_WORKSPACE: cwd,
        M7_PROJECT_PATH: cwd,
        M7_DEBUG: 'true',
        OPENAI_BASE_URL: `${stubUrl}/v1`,
        ANTHROPIC_BASE_URL: stubUrl,
      },
    });
    let stderr = '';
    transport.stderr?.on('data', (d) => {
      stderr += d;
    });
    const client = new Client({ name: 'sec-env-wiring', version: '0.0.0' }, { capabilities: {} });

    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the server did not answer initialize within ${EXIT_WAIT_MS} ms`)), EXIT_WAIT_MS);
      });
      try {
        await Promise.race([client.connect(transport), timeout]);
      } catch (error) {
        assert.fail(
          'the server did not start from an install tree that holds the .env: dist/index.js does not load the install-directory .env\n' +
            `${error instanceof Error ? error.message : String(error)}\nstderr tail: ${stderr.slice(-400)}`,
        );
      } finally {
        clearTimeout(timer);
      }
      assert.ok(client.getServerVersion(), 'the server answered initialize without a version');
    } finally {
      await client.close().catch(() => {});
    }
  });
});
