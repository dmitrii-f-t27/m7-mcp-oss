/**
 * SEC-21 (HIGH): every part of the server must work on the project the server resolved,
 * and must follow it when the client's Roots change.
 *
 * Failure before the fix: the constructor builds memory, journal, schema, orchestrator and
 * scope guard on the working directory, and several tools hold singletons or closures built
 * at that moment (task graph, task transfer, scope, TSI). The first resolution (Roots, or
 * M7_PROJECT_PATH when Roots give no answer) left all of them on the working directory for
 * the whole session. A schema update or a contract then rewrote a file of the wrong project,
 * and the journal, the session file, the task graph and the TSI data went to the wrong `.m7/`.
 * CURSOR_WORKSPACE hid the bug, because the constructor already resolves it.
 *
 * The server tests start the real MCP server (`node dist/index.js`) over stdio:
 *   - the working directory is project A, which has its own PROJECT_SCHEMA.yaml;
 *   - M7_PROJECT_PATH names project B, or the client answers `roots/list` with project C;
 *   - CURSOR_WORKSPACE is unset (the shared harness would set it, so these tests unset it).
 * Each server test makes the FIRST call to the server a tool call, because that call is
 * the one that used to see the stale objects. `assertUntouched` means that nothing at all
 * changed in project A: no allowance exists, and none may be added.
 *
 * The in-process tests call the built module `dist/core/utils/projectPath.js` with fake
 * servers. They cover the notice itself, the pure decision `needsProjectSwitch`, a
 * subscriber that must not rebuild for a path it already uses, the terminal path after
 * the Roots attempts ran out, and the registration of the `roots/list_changed` handler.
 *
 * Tests of the new export read it from the module inside the test, so a missing export
 * fails only that test and never hides the others.
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-stale-root.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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

/** Projects `<outer>/<name>`, each with its own PROJECT_SCHEMA.yaml. */
async function makeProjects(names) {
  const outer = await realpath(await mkdtemp(path.join(tmpdir(), 'sec-stale-root-')));
  cleanup.push(outer);
  const dirs = {};
  for (const name of names) {
    const dir = path.join(outer, name);
    await mkdir(dir);
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `fixture-${name}` }));
    await writeFile(path.join(dir, 'PROJECT_SCHEMA.yaml'), schemaText(`proj-${name}`));
    dirs[name] = dir;
  }
  return dirs;
}

/** Three projects `<outer>/A`, `<outer>/B`, `<outer>/C`. */
const makeTrio = () => makeProjects(['A', 'B', 'C']);

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

/** Fails when `after` has an entry `before` lacked, lost one, or changed one. Nothing is allowed. */
function assertUntouched(label, before, after) {
  const added = Object.keys(after).filter(k => !(k in before));
  const removed = Object.keys(before).filter(k => !(k in after));
  const changed = Object.keys(before).filter(k => k in after && before[k] !== after[k]);
  assert.deepEqual(
    { added, removed, changed },
    { added: [], removed: [], changed: [] },
    `${label} was touched by a server that was told to work elsewhere`,
  );
}

/** The same snapshot without the entries at or below `prefix` (a project that lives inside it). */
const without = (snap, prefix) =>
  Object.fromEntries(Object.entries(snap).filter(([k]) => k !== `${prefix}/` && !k.startsWith(`${prefix}/`)));

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
 * The first `failFirst` requests fail. `beforeConnect({ stderr })` runs after the server process
 * started and before the MCP handshake; it lets a test change the world between the two.
 * With `listChanged` the client declares `roots.listChanged`; then setRoots(), failRoots() and
 * sendRootsListChanged() change what it answers and tell the server, and rootsCalls() counts
 * the `roots/list` requests the server made.
 */
async function startWithRoots({ cwd, roots, delayMs = 0, env = {}, failFirst = 0, listChanged = false, beforeConnect = null }) {
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
  const state = { roots, calls: 0, failAll: false };
  const client = new Client(
    { name: 'stale-root-e2e', version: '0.0.0' },
    { capabilities: { roots: listChanged ? { listChanged: true } : {} } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    state.calls++;
    await sleep(delayMs);
    if (state.calls <= failFirst || state.failAll) throw new Error('roots unavailable');
    return { roots: state.roots.map(dir => ({ uri: pathToFileURL(dir).href, name: path.basename(dir) })) };
  });
  if (beforeConnect) {
    await transport.start();
    transport.start = async () => {}; // connect() must not spawn a second process
    try {
      await beforeConnect({ stderr: () => stderrChunks.join('') });
    } catch (err) {
      await transport.close().catch(() => {});
      throw err;
    }
  }
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

  return {
    client, transport, pid, call, stop,
    stderr: () => stderrChunks.join(''),
    setRoots: dirs => { state.roots = dirs; },
    failRoots: on => { state.failAll = on; },
    rootsCalls: () => state.calls,
    sendRootsListChanged: () => client.sendRootsListChanged(),
  };
}

/** Polls `predicate` every 50 ms for up to `ms`; true as soon as it holds. */
async function waitFor(predicate, ms = 8000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

/**
 * Starts a server, runs `body`, lets the journal flush (it batches writes for one second),
 * stops the server and returns it, so the caller reads files only after the process ended.
 */
async function session(start, body, flushMs = 1300) {
  const s = await start();
  try {
    await body(s);
    await sleep(flushMs);
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

  it('a Roots change reaches subscribers once and causes one switch', async () => {
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

    // The handler keeps the cache until the new answer arrives, so the one notice carries the real old path.
    assert.deepEqual(events, [[b, c]]);

    // What the server does with these notices: it switches only when it is not on newPath yet.
    let held = b;
    let switches = 0;
    for (const [, newPath] of events) {
      if (needsProjectSwitch(held, newPath)) {
        held = newPath;
        switches++;
      }
    }
    assert.equal(switches, 1, 'one notice for one change must cause one switch');
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

  it('the first analyze_task keeps its session, journal, task graph and schema reads in project B', T, async () => {
    const { A, B } = await makeTrio();
    const beforeA = await snapshot(A);
    await session(
      () => startNoRoots({ cwd: A, m7ProjectPath: B }),
      async s => { await s.call('mcp_m7_analyze_task', { task_description: TASK }); },
    );
    assertUntouched('the working directory', beforeA, await snapshot(A));
    assert.ok(existsSync(path.join(B, '.m7', 'orchestrator-sessions.json')), 'the session file of project B was not written');
    assert.ok(existsSync(path.join(B, '.m7', 'task-graph.json')), 'the task graph of project B was not written');
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

// ---------------------------------------------------------------------------
// The first call to every tool that holds project state
// ---------------------------------------------------------------------------

/**
 * [tool, arguments, entries that project B must hold afterwards].
 * Hive is not called here: it calls model APIs. The wrapper test below covers it.
 * `init_project` runs with B holding a non-empty project, so `force` is needed.
 */
const FIRST_CALLS = [
  ['mcp_m7_scope', { action: 'status' }, []],
  ['mcp_m7_task_transfer', { action: 'history' }, []],
  ['mcp_m7_task_graph', { action: 'status' }, ['.m7/task-graph.json']],
  ['mcp_m7_validate', { action: 'baseline_audit', quick_mode: true }, []],
  ['mcp_m7_check_errors', {}, []],
  ['mcp_m7_project_index', { action: 'generate' }, ['PROJECT_INDEX.md']],
  ['mcp_m7_console', { action: 'start' }, []],
  ['mcp_m7_impact', { action: 'history' }, []],
  ['mcp_m7_get_patterns', { technology: 'typescript' }, ['.m7/tsi']],
  ['mcp_m7_init_project', { force: true, project_name: 'fixture-B' }, []],
];

describe('SEC-21: the first call, whatever it is, leaves the working directory alone', () => {
  it('a server that starts and exits with no tool call leaves project A byte-identical', T, async () => {
    const { A, B } = await makeTrio();
    const beforeA = await snapshot(A);
    await session(
      () => startNoRoots({ cwd: A, m7ProjectPath: B }),
      async () => {},
    );
    assertUntouched('the working directory', beforeA, await snapshot(A));
  });

  for (const [tool, args, expectInB] of FIRST_CALLS) {
    it(`${tool}: the first call leaves project A byte-identical`, T, async () => {
      const { A, B } = await makeTrio();
      const beforeA = await snapshot(A);
      let res;
      await session(
        () => startNoRoots({ cwd: A, m7ProjectPath: B }),
        async s => { res = await s.call(tool, args); },
        500,
      );
      assert.ok(res && Array.isArray(res.content), `${tool} must answer`);
      assertUntouched('the working directory', beforeA, await snapshot(A));
      for (const rel of expectInB) {
        assert.ok(existsSync(path.join(B, rel)), `${tool} must work on project B: ${rel} is missing there`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The scan guess (cwd is a bare home directory)
// ---------------------------------------------------------------------------

const homeSlugOf = home => home.replace(/^(?:[A-Za-z]:)?[\\/]/, '').replace(/[\\/]/g, '-');

/**
 * A fake home directory that has its own PROJECT_SCHEMA.yaml and no package.json, a project
 * `<home>/Documents/dev/<name>`, and a Cursor projects directory whose recent transcripts name
 * that project, so that only the activity scan can find it. Returns the paths.
 */
function makeScanHome(outer, name) {
  const home = path.join(outer, 'home');
  const project = path.join(home, 'Documents', 'dev', name);
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'package.json'), '{}');
  writeFileSync(path.join(project, 'PROJECT_SCHEMA.yaml'), schemaText(`proj-${name}`));
  writeFileSync(path.join(home, 'PROJECT_SCHEMA.yaml'), schemaText('proj-HOME'));
  const projectsRoot = path.join(outer, 'cursor-projects');
  const slugDir = path.join(projectsRoot, `${homeSlugOf(home)}-Documents-dev-${name}`);
  mkdirSync(path.join(slugDir, 'agent-transcripts'), { recursive: true });
  writeFileSync(path.join(slugDir, 'agent-transcripts', 'recent.jsonl'), '{"event":"test"}\n');
  return { home, project, projectsRoot, rel: `Documents/dev/${name}` };
}

describe('SEC-21: the scan guess of a bare home directory', () => {
  it('Roots that fail twice and then name the scan target move the systems; the home directory stays byte-identical', T, async () => {
    const outer = await realpath(await mkdtemp(path.join(tmpdir(), 'sec-stale-root-home-')));
    cleanup.push(outer);
    const { home, project, projectsRoot, rel } = makeScanHome(outer, 'ScanTarget');
    const beforeHome = without(await snapshot(home), rel);
    let text = '';
    await session(
      () => startWithRoots({
        cwd: home,
        roots: [project],
        failFirst: 2,
        env: { HOME: home, USERPROFILE: home, CURSOR_PROJECTS_DIR: projectsRoot },
      }),
      async s => { text = (await s.call(SCHEMA_TOOL, UPDATE('written-by-guard'))).text; },
    );
    assert.match(text, /"success": true/, `the update must succeed:\n${text.slice(0, 500)}`);
    assertUntouched('the home directory', beforeHome, without(await snapshot(home), rel));
    assert.match(await readText(path.join(project, 'PROJECT_SCHEMA.yaml')), /written-by-guard/, 'the scan target did not get the update');
  });

  it('a scan guess that changes between start and initialization does not replace the systems', T, async () => {
    const outer = await realpath(await mkdtemp(path.join(tmpdir(), 'sec-stale-root-home2-')));
    cleanup.push(outer);
    // ScanFirst is the only project with transcripts when the server starts (and they are old).
    const first = makeScanHome(outer, 'ScanFirst');
    const old = new Date(Date.now() - 3_600_000);
    const firstSlug = path.join(first.projectsRoot, `${homeSlugOf(first.home)}-Documents-dev-ScanFirst`);
    for (const p of [path.join(firstSlug, 'agent-transcripts', 'recent.jsonl'), path.join(firstSlug, 'agent-transcripts'), firstSlug]) {
      utimesSync(p, old, old);
    }
    // ScanSecond gets fresh transcripts after the server started and before the client says hello.
    const secondRel = 'Documents/dev/ScanSecond';
    const second = path.join(first.home, secondRel);
    mkdirSync(second, { recursive: true });
    writeFileSync(path.join(second, 'package.json'), '{}');
    writeFileSync(path.join(second, 'PROJECT_SCHEMA.yaml'), schemaText('proj-ScanSecond'));
    const secondSlug = path.join(first.projectsRoot, `${homeSlugOf(first.home)}-Documents-dev-ScanSecond`);
    const homeOnly = snap => without(without(snap, first.rel), secondRel);
    const beforeHome = homeOnly(await snapshot(first.home));

    let text = '';
    const s = await session(
      () => startWithRoots({
        cwd: first.home,
        roots: [second],
        failFirst: 2,
        env: { HOME: first.home, USERPROFILE: first.home, CURSOR_PROJECTS_DIR: first.projectsRoot, M7_DEBUG: 'true' },
        beforeConnect: async ({ stderr }) => {
          assert.ok(await waitFor(() => stderr().includes('Project Path:')), 'the server did not start');
          mkdirSync(path.join(secondSlug, 'agent-transcripts'), { recursive: true });
          writeFileSync(path.join(secondSlug, 'agent-transcripts', 'recent.jsonl'), '{"event":"test"}\n');
        },
      }),
      async server => {
        // The first tool call must come after the server used up the two failing Roots attempts
        // while it initialized (its debug log says so), as it does when a real client takes its time.
        assert.ok(
          await waitFor(() => server.stderr().includes('Roots pending')),
          'the server did not finish initializing without Roots',
        );
        text = (await server.call(SCHEMA_TOOL, UPDATE('written-by-second'))).text;
      },
    );
    assert.ok(
      s.stderr().includes(`Project Path: ${first.project}`),
      'the test needs the server to have started on the first scan target',
    );
    assert.match(text, /"success": true/, `the update must succeed:\n${text.slice(0, 500)}`);
    assert.match(await readText(path.join(second, 'PROJECT_SCHEMA.yaml')), /written-by-second/, 'the project the Roots named did not get the update');
    assert.doesNotMatch(await readText(path.join(first.project, 'PROJECT_SCHEMA.yaml')), /written-by-second/, 'the update went to the project the server started on');
    assertUntouched('the home directory', beforeHome, homeOnly(await snapshot(first.home)));
  });
});

describe('SEC-21: the terminal path after the Roots attempts ran out', () => {
  const ENV_KEYS = [
    'CURSOR_WORKSPACE', 'WORKSPACE_FOLDER_PATHS', 'AGENT_TRANSCRIPTS', 'M7_PROJECT_PATH',
    'CURSOR_PROJECTS_DIR', 'HOME', 'USERPROFILE',
  ];
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  const savedCwd = process.cwd();
  let events = [];
  pp.onProjectPathChange((oldPath, newPath) => events.push([oldPath, newPath]));

  beforeEach(() => {
    pp.resetProjectPathStateForTests();
    for (const key of ENV_KEYS) delete process.env[key];
    events = [];
  });
  after(() => {
    pp.resetProjectPathStateForTests();
    process.chdir(savedCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('a failing server called 6 times with a scan target gives one event [null, target]', async () => {
    const outer = realpathSync(mkdtempSync(path.join(tmpdir(), 'sec-stale-root-ip-home-')));
    cleanup.push(outer);
    const { home, project, projectsRoot } = makeScanHome(outer, 'ScanTarget');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CURSOR_PROJECTS_DIR = projectsRoot;
    process.chdir(home);
    assert.equal(homedir(), home, 'the test needs os.homedir() to follow HOME');

    let calls = 0;
    const failing = {
      listRoots: async () => {
        calls++;
        throw new Error('roots unavailable');
      },
    };
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push(await pp.ensureProjectPathResolved(failing));

    assert.equal(calls, 5, 'the server must stop asking after 5 attempts');
    assert.deepEqual(answers.slice(0, 5), Array(5).fill(project), 'every call must answer with the scan target');
    assert.deepEqual(answers[5], project);
    assert.deepEqual(events, [[null, project]], 'the terminal path must tell subscribers about the path it caches');
  });
});

// ---------------------------------------------------------------------------
// The built server waits for the workspace in one place
// ---------------------------------------------------------------------------

describe('SEC-21: the wrapper waits for the workspace', () => {
  it('registerTool awaits the workspace before it calls the handler, and no factory captures a system', async () => {
    const src = await readFile(path.join(DIST, 'index.js'), 'utf8');
    const waitAt = src.search(/if \(!isRootsResolutionComplete\(\)\)\s*await ensureProjectPathResolved\(this\.server\)/);
    const callAt = src.indexOf('await handler(args)');
    assert.ok(waitAt >= 0, 'dist/index.js has no wrapper await guarded by isRootsResolutionComplete()');
    assert.ok(callAt > waitAt, 'the wrapper await must come before await handler(args)');
    assert.doesNotMatch(src, /createScopeTool\(this\./, 'createScopeTool still captures a system built at start');
    assert.doesNotMatch(src, /createTaskTransferTool\(this\./, 'createTaskTransferTool still captures a system built at start');
  });
});

// ---------------------------------------------------------------------------
// A Roots change during the session (real process, live probe)
// ---------------------------------------------------------------------------

describe('SEC-21: a Roots change moves the session', () => {
  /** Roots answer B; waits until the server has switched to `next`, which the debug log reports. */
  async function changeRoots(s, next, { expectSwitch = true } = {}) {
    const seen = s.rootsCalls();
    s.setRoots([next]);
    await s.sendRootsListChanged();
    assert.ok(
      await waitFor(() => s.rootsCalls() > seen),
      'the server did not ask roots/list again after roots/list_changed',
    );
    if (expectSwitch) {
      assert.ok(
        await waitFor(() => s.stderr().includes(`→ ${next}`)),
        `the server did not switch to ${next}`,
      );
    }
  }

  it('the update after the change writes C; B and A stay unchanged', T, async () => {
    const { A, B, C } = await makeTrio();
    const beforeA = await snapshot(A);
    let beforeB;
    let first = '';
    let second = '';
    await session(
      () => startWithRoots({ cwd: A, roots: [B], listChanged: true, env: { M7_DEBUG: 'true' } }),
      async s => {
        first = (await s.call(SCHEMA_TOOL, UPDATE('written-in-b'))).text;
        await sleep(1300); // the journal batches its writes for one second
        beforeB = await snapshot(B);
        await changeRoots(s, C);
        second = (await s.call(SCHEMA_TOOL, UPDATE('written-in-c'))).text;
      },
    );
    assert.match(first, /"success": true/, `the first update must succeed:\n${first.slice(0, 500)}`);
    assert.match(second, /"success": true/, `the second update must succeed:\n${second.slice(0, 500)}`);
    assert.match(await readText(path.join(B, 'PROJECT_SCHEMA.yaml')), /written-in-b/, 'project B did not get the first update');
    assert.match(await readText(path.join(C, 'PROJECT_SCHEMA.yaml')), /written-in-c/, 'project C did not get the update after the change');
    assertUntouched('project B after the change', beforeB, await snapshot(B));
    assertUntouched('the working directory', beforeA, await snapshot(A));
  });

  it('analyze_task after the change puts the task graph in C and not in B', T, async () => {
    const { A, B, C } = await makeTrio();
    const beforeA = await snapshot(A);
    await session(
      () => startWithRoots({ cwd: A, roots: [B], listChanged: true, env: { M7_DEBUG: 'true' } }),
      async s => {
        await s.call(SCHEMA_TOOL, VIEW);
        await changeRoots(s, C);
        await s.call('mcp_m7_analyze_task', { task_description: TASK });
      },
    );
    assert.ok(existsSync(path.join(C, '.m7', 'task-graph.json')), 'the task graph of project C was not written');
    assert.ok(!existsSync(path.join(B, '.m7', 'task-graph.json')), 'the task graph went to project B');
    assertUntouched('the working directory', beforeA, await snapshot(A));
  });

  it('an explicit project_path stays after a Roots change', T, async () => {
    const { A, B, C, D } = await makeProjects(['A', 'B', 'C', 'D']);
    const beforeA = await snapshot(A);
    const beforeB = await snapshot(B);
    const beforeC = await snapshot(C);
    let text = '';
    await session(
      () => startWithRoots({ cwd: A, roots: [B], listChanged: true }),
      async s => {
        await s.call('mcp_m7_init_project', { project_path: D, force: true });
        const seen = s.rootsCalls();
        s.setRoots([C]);
        await s.sendRootsListChanged();
        await sleep(1500); // nothing to wait for: the server must not react
        assert.equal(s.rootsCalls(), seen, 'the server asked roots/list although an explicit project_path is set');
        text = (await s.call(SCHEMA_TOOL, UPDATE('written-in-d'))).text;
      },
    );
    assert.match(text, /"success": true/, `the update must succeed:\n${text.slice(0, 500)}`);
    assert.match(await readText(path.join(D, 'PROJECT_SCHEMA.yaml')), /written-in-d/, 'the explicit project did not get the update');
    assertUntouched('project B', beforeB, await snapshot(B));
    assertUntouched('project C', beforeC, await snapshot(C));
    assertUntouched('the working directory', beforeA, await snapshot(A));
  });

  it('a refresh that fails leaves the session on B, and the tools still work on B', T, async () => {
    const { A, B } = await makeTrio();
    const beforeA = await snapshot(A);
    let update = '';
    await session(
      () => startWithRoots({ cwd: A, roots: [B], listChanged: true }),
      async s => {
        await s.call(SCHEMA_TOOL, VIEW);
        const seen = s.rootsCalls();
        s.failRoots(true);
        await s.sendRootsListChanged();
        assert.ok(
          await waitFor(() => s.rootsCalls() > seen),
          'the server did not ask roots/list again after roots/list_changed',
        );
        await sleep(500); // the server handles the failure
        update = (await s.call(SCHEMA_TOOL, UPDATE('written-after-failed-refresh'))).text;
        await s.call('mcp_m7_analyze_task', { task_description: TASK });
      },
    );
    assert.match(update, /"success": true/, `the update must succeed:\n${update.slice(0, 500)}`);
    assert.match(await readText(path.join(B, 'PROJECT_SCHEMA.yaml')), /written-after-failed-refresh/, 'project B did not get the update');
    assert.ok(existsSync(path.join(B, '.m7', 'task-graph.json')), 'the task graph of project B was not written');
    assertUntouched('the working directory', beforeA, await snapshot(A));
  });

  // The test above has M7_PROJECT_PATH unset, so a session that lost its Roots flag had nowhere
  // to go. With M7_PROJECT_PATH set, the next ensureProjectPathResolved call used to apply it.
  it('a refresh that fails leaves the session on B when M7_PROJECT_PATH names C', T, async () => {
    const { A, B, C } = await makeTrio();
    const beforeA = await snapshot(A);
    const beforeC = await snapshot(C);
    let update = '';
    await session(
      () => startWithRoots({ cwd: A, roots: [B], listChanged: true, env: { M7_PROJECT_PATH: C } }),
      async s => {
        await s.call(SCHEMA_TOOL, VIEW);
        const seen = s.rootsCalls();
        s.failRoots(true);
        await s.sendRootsListChanged();
        assert.ok(
          await waitFor(() => s.rootsCalls() > seen),
          'the server did not ask roots/list again after roots/list_changed',
        );
        await sleep(500); // the server handles the failure
        await s.call('mcp_m7_analyze_task', { task_description: TASK });
        update = (await s.call(SCHEMA_TOOL, UPDATE('written-after-failed-refresh'))).text;
      },
    );
    assert.ok(existsSync(path.join(B, '.m7', 'task-graph.json')), 'the task graph of project B was not written');
    assert.ok(!existsSync(path.join(C, '.m7', 'task-graph.json')), 'analyze_task moved the session to M7_PROJECT_PATH (project C) after a failed refresh');
    assertUntouched('project C (M7_PROJECT_PATH)', beforeC, await snapshot(C));
    assert.match(update, /"success": true/, `the update must succeed:\n${update.slice(0, 500)}`);
    assert.match(await readText(path.join(B, 'PROJECT_SCHEMA.yaml')), /written-after-failed-refresh/, 'project B did not get the update');
    assertUntouched('the working directory', beforeA, await snapshot(A));
  });
});

// ---------------------------------------------------------------------------
// Registering the roots/list_changed handler (in process)
// ---------------------------------------------------------------------------

describe('SEC-21: registering the roots/list_changed handler', () => {
  beforeEach(() => pp.resetProjectPathStateForTests());
  after(() => pp.resetProjectPathStateForTests());

  it('a server whose setNotificationHandler throws does not stop the binding, and diagnostics say so', () => {
    const server = {
      setNotificationHandler: () => {
        throw new Error('boom: cannot register');
      },
      listRoots: async () => ({ roots: [] }),
    };
    assert.doesNotThrow(() => pp.bindMcpServerForRoots(server));
    const diag = pp.getProjectPathDiagnostics();
    assert.equal(diag.rootsChangeHandlerRegistered, false);
    assert.match(String(diag.rootsChangeHandlerError), /boom: cannot register/);

    pp.resetProjectPathStateForTests();
    const cleared = pp.getProjectPathDiagnostics();
    assert.equal(cleared.rootsChangeHandlerRegistered, false);
    assert.equal(cleared.rootsChangeHandlerError ?? null, null, 'the reset must clear the recorded failure');
  });

  it('a working server gets the handler with the SDK schema, and diagnostics report it', async () => {
    const { RootsListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const got = [];
    const server = { setNotificationHandler: (schema, handler) => got.push({ schema, handler }) };
    pp.bindMcpServerForRoots(server);
    assert.equal(got.length, 1, 'the handler must be registered once');
    assert.ok(got[0].schema === RootsListChangedNotificationSchema, 'the handler must be registered with the SDK schema, not a plain object');
    assert.equal(typeof got[0].handler, 'function');
    const diag = pp.getProjectPathDiagnostics();
    assert.equal(diag.rootsChangeHandlerRegistered, true);
    assert.equal(diag.rootsChangeHandlerError ?? null, null);
  });
});
