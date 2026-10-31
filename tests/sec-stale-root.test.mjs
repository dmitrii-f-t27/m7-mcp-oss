/**
 * SEC-21 (HIGH): the first project path the server resolves must reach every part of it.
 *
 * Failure before the fix: the constructor builds memory, journal, schema, orchestrator and
 * scope guard on the working directory. The first resolution (Roots, or M7_PROJECT_PATH when
 * Roots give no answer) found no earlier path, sent no notice, and left all of them on the
 * working directory for the whole session. A schema update or a contract then rewrote a file
 * of the wrong project, and the journal and the session file went to the wrong `.m7/`.
 * CURSOR_WORKSPACE hid the bug, because the constructor already resolves it.
 *
 * The server tests start the real MCP server (`node dist/index.js`) over stdio:
 *   - the working directory is project A, which has its own PROJECT_SCHEMA.yaml;
 *   - M7_PROJECT_PATH names project B, or the client answers `roots/list` with project C;
 *   - CURSOR_WORKSPACE is unset (the shared harness would set it, so these tests unset it).
 * Each server test makes the FIRST call to the server a tool call, because that call is
 * the one that used to see the stale objects.
 *
 * The in-process tests call the built module `dist/core/utils/projectPath.js` with fake
 * servers. They cover the notice itself, the pure decision `needsProjectSwitch`, a
 * subscriber that is told twice, and the memory core that must survive a notice that
 * names the path it already works on.
 *
 * Tests of the new export read it from the module inside the test, so a missing export
 * fails only that test and never hides the others.
 *
 * Limit, stated on purpose: with the installed MCP SDK the `roots/list_changed` handler
 * does not register (setNotificationHandler rejects a plain object and projectPath.ts
 * swallows the error). The server tests therefore cannot send a Roots change; the
 * in-process test calls the handler through a fake server.
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-stale-root.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { DIST, isolatedEnv, startServer } from './helpers/deepScanHarness.mjs';

const pp = await import('../dist/core/utils/projectPath.js');

const T = { timeout: 90_000 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TASK = 'Add retry to the HTTP client wrapper in network layer';
const SCHEMA_TOOL = 'mcp_m7_schema';
const UPDATE = marker => ({ action: 'update', component: 'architecture', changes: { type: marker } });
const VIEW = { action: 'view', component: 'all', format: 'json' };

const cleanup = [];
after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const schemaText = name =>
  `project:\n  name: ${name}\n  version: 1.0.0\n  last_updated: "2020-01-01T00:00:00.000Z"\n`;

/** Three projects `<outer>/A`, `<outer>/B`, `<outer>/C`, each with its own PROJECT_SCHEMA.yaml. */
async function makeTrio() {
  const outer = await realpath(await mkdtemp(path.join(tmpdir(), 'sec-stale-root-')));
  cleanup.push(outer);
  const dirs = {};
  for (const name of ['A', 'B', 'C']) {
    const dir = path.join(outer, name);
    await mkdir(dir);
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `fixture-${name}` }));
    await writeFile(path.join(dir, 'PROJECT_SCHEMA.yaml'), schemaText(`proj-${name}`));
    dirs[name] = dir;
  }
  return dirs;
}

/** Every entry under `root` mapped to its content (directories map to ''), symlinks not followed. */
async function snapshot(root) {
  const out = {};
  async function walk(rel) {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[`${r}/`] = '';
        await walk(r);
      } else {
        out[r] = (await readFile(path.join(root, r))).toString('base64');
      }
    }
  }
  await walk('');
  return out;
}

/**
 * TSISystem builds `.m7/tsi/` in the startup directory while the server starts (its
 * data path is relative). That is a separate defect, not part of this fix, so the
 * check below skips `.m7/tsi/` and the `.m7/` directory that holds it. Any other
 * entry in `.m7/` (the journal, the session file, the task graph) still counts.
 */
const startupScaffolding = key => key === '.m7/' || key.startsWith('.m7/tsi/');

/**
 * Fails when `after` has an entry `before` lacked, lost one, or changed one.
 * `allowedAdditions` names entries that may appear anyway; a test that passes any says why.
 */
function assertUntouched(label, before, after, allowedAdditions = []) {
  const added = Object.keys(after).filter(
    k => !(k in before) && !startupScaffolding(k) && !allowedAdditions.includes(k),
  );
  const removed = Object.keys(before).filter(k => !(k in after));
  const changed = Object.keys(before).filter(k => k in after && before[k] !== after[k]);
  assert.deepEqual(
    { added, removed, changed },
    { added: [], removed: [], changed: [] },
    `${label} was touched by a server that was told to work elsewhere`,
  );
}

/** The server starts in `cwd` and M7_PROJECT_PATH names another project. The client has no Roots. */
function startNoRoots({ cwd, m7ProjectPath, env = {} }) {
  return startServer(cwd, {
    cwd,
    env: { CURSOR_WORKSPACE: undefined, M7_PROJECT_PATH: m7ProjectPath, ...env },
  });
}

/**
 * Same server, but the client declares Roots and answers `roots/list` with `roots`
 * after `delayMs`. A delay keeps the first tool call ahead of the answer.
 */
async function startWithRoots({ cwd, roots, delayMs = 0, env = {} }) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { ListRootsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(DIST, 'index.js')],
    env: isolatedEnv(cwd, { CURSOR_WORKSPACE: undefined, M7_PROJECT_PATH: undefined, ...env }),
    cwd,
    stderr: 'pipe',
  });
  const stderrChunks = [];
  transport.stderr?.on('data', chunk => stderrChunks.push(String(chunk)));
  const client = new Client({ name: 'stale-root-e2e', version: '0.0.0' }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    await sleep(delayMs);
    return { roots: roots.map(dir => ({ uri: pathToFileURL(dir).href, name: path.basename(dir) })) };
  });
  await client.connect(transport);
  const pid = transport.pid;

  async function call(name, args) {
    const res = await client.callTool({ name, arguments: args });
    return { ...res, text: (res.content ?? []).map(c => c.text ?? '').join('\n') };
  }

  async function stop() {
    await client.close().catch(() => {});
    for (let waited = 0; waited < 5000; waited += 25) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await sleep(25);
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    return false;
  }

  return { client, transport, pid, call, stop, stderr: () => stderrChunks.join('') };
}

/**
 * Starts a server, runs `body`, lets the journal flush (it batches writes for one second),
 * stops the server and returns it, so the caller reads files only after the process ended.
 */
async function session(start, body) {
  const s = await start();
  try {
    await body(s);
    await sleep(1300);
  } finally {
    await s.stop('close');
  }
  return s;
}

const readText = file => readFile(file, 'utf8');

// ---------------------------------------------------------------------------
// The decision (pure)
// ---------------------------------------------------------------------------

describe('SEC-21: needsProjectSwitch (pure)', () => {
  it('a subscriber with no path yet must switch; the same path, written any way, must not', async () => {
    const { needsProjectSwitch } = pp;
    assert.equal(typeof needsProjectSwitch, 'function', 'projectPath.js must export needsProjectSwitch');
    const base = path.join(tmpdir(), 'p');
    const cases = [
      [null, base, true],
      [base, base, false],
      [`${base}${path.sep}`, base, false],
      [path.join(base, 'x', '..'), base, false],
      [base, path.join(tmpdir(), 'q'), true],
      [base, path.join(base, 'sub'), true],
    ];
    for (const [current, next, expected] of cases) {
      assert.equal(needsProjectSwitch(current, next), expected, `needsProjectSwitch(${current}, ${next})`);
    }
  });
});

// ---------------------------------------------------------------------------
// The notice (in process, fake servers)
// ---------------------------------------------------------------------------

describe('SEC-21: subscribers hear the first resolution', () => {
  const ENV_KEYS = ['CURSOR_WORKSPACE', 'WORKSPACE_FOLDER_PATHS', 'AGENT_TRANSCRIPTS', 'M7_PROJECT_PATH'];
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  let events = [];
  pp.onProjectPathChange((oldPath, newPath) => events.push([oldPath, newPath]));

  const project = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sec-stale-root-ip-')));
    writeFileSync(path.join(dir, 'package.json'), '{}');
    cleanup.push(dir);
    return dir;
  };
  const rootsServer = (...dirs) => ({
    listRoots: async () => ({ roots: dirs.map(dir => ({ uri: pathToFileURL(dir).href })) }),
  });
  const failingRootsServer = () => ({
    listRoots: async () => {
      throw new Error('roots unavailable');
    },
  });

  beforeEach(() => {
    pp.resetProjectPathStateForTests();
    for (const key of ENV_KEYS) delete process.env[key];
    events = [];
  });
  after(() => {
    pp.resetProjectPathStateForTests();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('the first Roots answer notifies with oldPath null; the same answer again is silent', async () => {
    const c = project();
    const got = await pp.fetchWorkspaceFromMcpRoots(rootsServer(c));
    assert.equal(got, c);
    assert.deepEqual(events, [[null, c]], 'the first resolution must reach subscribers');
    await pp.fetchWorkspaceFromMcpRoots(rootsServer(c));
    assert.deepEqual(events, [[null, c]], 'the same path again must not notify');
  });

  it('M7_PROJECT_PATH used after a failed Roots call notifies with oldPath null', async () => {
    const b = project();
    process.env.M7_PROJECT_PATH = b;
    const got = await pp.ensureProjectPathResolved(failingRootsServer());
    assert.equal(got, b);
    assert.deepEqual(events, [[null, b]], 'the first resolution must reach subscribers');
    await pp.ensureProjectPathResolved(failingRootsServer());
    assert.deepEqual(events, [[null, b]], 'the same path again must not notify');
  });

  it('a Roots change that reaches subscribers twice causes one switch', async () => {
    const { needsProjectSwitch } = pp;
    assert.equal(typeof needsProjectSwitch, 'function', 'projectPath.js must export needsProjectSwitch');
    const b = project();
    const c = project();
    let current = [b];
    let onListChanged = null;
    const server = {
      setNotificationHandler: (_schema, handler) => { onListChanged = handler; },
      listRoots: async () => ({ roots: current.map(dir => ({ uri: pathToFileURL(dir).href })) }),
    };
    pp.bindMcpServerForRoots(server);
    assert.equal(typeof onListChanged, 'function', 'the fake server must have received the handler');
    assert.equal(await pp.fetchWorkspaceFromMcpRoots(server), b);

    events = [];
    current = [c];
    await onListChanged();

    // The handler notifies from inside the Roots fetch (oldPath null, because it clears the
    // cache first) and again once the fetch returns (oldPath b).
    assert.deepEqual(events, [[null, c], [b, c]]);

    // What the server does with these notices: it switches only when it is not on newPath yet.
    let held = b;
    let switches = 0;
    for (const [, newPath] of events) {
      if (needsProjectSwitch(held, newPath)) {
        held = newPath;
        switches++;
      }
    }
    assert.equal(switches, 1, 'two notices for one change must cause one switch');
    assert.equal(held, c);
  });

  it('the memory core survives a notice that names the path it already works on', async () => {
    const mem = await import('../dist/memory/auto/unified-memory-core.js');
    const p = project();
    mem.resetMemoryCore();
    try {
      const first = await mem.getMemoryCore(p);
      assert.equal(await pp.fetchWorkspaceFromMcpRoots(rootsServer(p)), p);
      assert.deepEqual(events, [[null, p]], 'the notice for the first resolution must be sent');
      const second = await mem.getMemoryCore(p);
      assert.equal(second, first, 'a notice for the same path must not replace the memory core');
    } finally {
      await mem.shutdownMemoryCore();
      mem.resetMemoryCore();
    }
  });
});

// ---------------------------------------------------------------------------
// The server (real process)
// ---------------------------------------------------------------------------

describe('SEC-21: M7_PROJECT_PATH names project B, cwd is project A, the client has no Roots', () => {
  it('the first schema view reads project B', T, async () => {
    const { A, B } = await makeTrio();
    let text = '';
    await session(
      () => startNoRoots({ cwd: A, m7ProjectPath: B }),
      async s => { text = (await s.call(SCHEMA_TOOL, VIEW)).text; },
    );
    assert.match(text, /proj-B/, `the first call must read project B:\n${text.slice(0, 500)}`);
    assert.doesNotMatch(text, /proj-A/, 'the first call read the schema of the working directory');
  });

  it('the first schema update writes project B and leaves project A byte-identical', T, async () => {
    const { A, B } = await makeTrio();
    const beforeA = await snapshot(A);
    let text = '';
    await session(
      () => startNoRoots({ cwd: A, m7ProjectPath: B }),
      async s => { text = (await s.call(SCHEMA_TOOL, UPDATE('written-by-update'))).text; },
    );
    assert.match(text, /"success": true/, `the update must succeed:\n${text.slice(0, 500)}`);
    assertUntouched('the working directory', beforeA, await snapshot(A));
    assert.match(await readText(path.join(B, 'PROJECT_SCHEMA.yaml')), /written-by-update/, 'project B did not get the update');
    assert.ok(existsSync(path.join(B, '.m7', 'features.json')), 'the journal of project B was not written');
    assert.ok(!existsSync(path.join(A, '.m7', 'features.json')), 'the journal wrote into the working directory');
  });

  it('the first contracts call registers into project B and leaves project A byte-identical', T, async () => {
    const { A, B } = await makeTrio();
    const beforeA = await snapshot(A);
    let text = '';
    await session(
      () => startNoRoots({ cwd: A, m7ProjectPath: B }),
      async s => {
        text = (await s.call('mcp_m7_contracts', {
          action: 'register',
          contract: { name: 'fetchWidgetFromStore', type: 'function', purpose: 'fetch one widget from the store by id' },
        })).text;
      },
    );
    assert.match(text, /"success": true/, `the registration must succeed:\n${text.slice(0, 500)}`);
    assertUntouched('the working directory', beforeA, await snapshot(A));
    assert.match(await readText(path.join(B, 'PROJECT_SCHEMA.yaml')), /fetchWidgetFromStore/, 'project B did not get the contract');
  });

  it('the first analyze_task keeps its session, journal and schema reads in project B', T, async () => {
    const { A, B } = await makeTrio();
    const beforeA = await snapshot(A);
    await session(
      () => startNoRoots({ cwd: A, m7ProjectPath: B }),
      async s => { await s.call('mcp_m7_analyze_task', { task_description: TASK }); },
    );
    // Not covered by this fix, so allowed here and nowhere else: the task graph manager is a
    // singleton built while the server starts, so `.m7/task-graph.json` still goes to the
    // working directory. That is a separate defect.
    assertUntouched('the working directory', beforeA, await snapshot(A), ['.m7/task-graph.json']);
    assert.ok(existsSync(path.join(B, '.m7', 'orchestrator-sessions.json')), 'the session file of project B was not written');
  });
});

describe('SEC-21: the client answers roots/list with project C, cwd is A, M7_PROJECT_PATH is B', () => {
  it('a first schema update that arrives before the Roots answer still writes project C only', T, async () => {
    const { A, B, C } = await makeTrio();
    const beforeA = await snapshot(A);
    const beforeB = await snapshot(B);
    let text = '';
    await session(
      () => startWithRoots({ cwd: A, roots: [C], delayMs: 700, env: { M7_PROJECT_PATH: B } }),
      async s => { text = (await s.call(SCHEMA_TOOL, UPDATE('written-by-roots'))).text; },
    );
    assert.match(text, /"success": true/, `the update must succeed:\n${text.slice(0, 500)}`);
    assertUntouched('the working directory', beforeA, await snapshot(A));
    assertUntouched('the project named by M7_PROJECT_PATH', beforeB, await snapshot(B));
    assert.match(await readText(path.join(C, 'PROJECT_SCHEMA.yaml')), /written-by-roots/, 'project C did not get the update');
  });

  it('a first schema view that arrives before the Roots answer reads project C', T, async () => {
    const { A, B, C } = await makeTrio();
    let text = '';
    await session(
      () => startWithRoots({ cwd: A, roots: [C], delayMs: 700, env: { M7_PROJECT_PATH: B } }),
      async s => { text = (await s.call(SCHEMA_TOOL, VIEW)).text; },
    );
    assert.match(text, /proj-C/, `the first call must read project C:\n${text.slice(0, 500)}`);
    assert.doesNotMatch(text, /proj-[AB]/, 'the first call read the schema of the working directory or of M7_PROJECT_PATH');
  });

  it('a first schema update that arrives after the Roots answer writes project C only', T, async () => {
    const { A, B, C } = await makeTrio();
    const beforeA = await snapshot(A);
    const beforeB = await snapshot(B);
    await session(
      () => startWithRoots({ cwd: A, roots: [C], env: { M7_PROJECT_PATH: B } }),
      async s => {
        await sleep(600);
        await s.call(SCHEMA_TOOL, UPDATE('written-after-roots'));
      },
    );
    assertUntouched('the working directory', beforeA, await snapshot(A));
    assertUntouched('the project named by M7_PROJECT_PATH', beforeB, await snapshot(B));
    assert.match(await readText(path.join(C, 'PROJECT_SCHEMA.yaml')), /written-after-roots/, 'project C did not get the update');
  });
});

describe('SEC-21: the first resolution names the project the server already works on', () => {
  it('Roots that answer with the working directory cause no switch', T, async () => {
    const { A } = await makeTrio();
    let text = '';
    const s = await session(
      () => startWithRoots({ cwd: A, roots: [A], env: { M7_DEBUG: 'true' } }),
      async server => { text = (await server.call(SCHEMA_TOOL, UPDATE('written-in-place'))).text; },
    );
    assert.match(text, /"success": true/, `the update must succeed:\n${text.slice(0, 500)}`);
    assert.match(await readText(path.join(A, 'PROJECT_SCHEMA.yaml')), /written-in-place/, 'the update did not reach the project');
    const switches = s.stderr().split('\n').filter(line => line.includes('[M7 Server] Project path changed:'));
    assert.deepEqual(switches, [], 'the server rebuilt its systems for a path it already used');
  });
});
