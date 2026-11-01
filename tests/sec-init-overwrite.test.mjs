// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * SEC-2 (HIGH): M7 never overwrites a project file, and sets a project up on
 * its own only in an empty directory.
 *
 * Every server test starts the real MCP server (`node dist/index.js`) over
 * stdio on a throwaway project, calls one tool, stops the server and then
 * compares the project on disk with what was seeded.
 *
 * Not counted as a project file: `.m7/` and `m7-cycles/` (M7 runtime data).
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-init-overwrite.test.mjs
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DIST, makeProject, removeProject, startServer } from './helpers/deepScanHarness.mjs';

const T = { timeout: 90_000 };
const MARKER = '<!-- m7-managed -->';
const TASK = 'Add retry to the HTTP client wrapper in network layer';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MEMORY_BANK_FILES = [
  'memory-bank/projectbrief.md',
  'memory-bank/productContext.md',
  'memory-bank/activeContext.md',
  'memory-bank/systemPatterns.md',
  'memory-bank/techContext.md',
  'memory-bank/progress.md',
];

/** Every file `init_project` and the cold start write, as a project-relative path. */
const SEEDED_BY_INIT = [
  'README.md',
  '.cursorrules',
  'INDEX.md',
  'MASTER_REFERENCE.md',
  'CODING_STANDARDS.md',
  'CYCLE_REGISTRY.md',
  '.cursor/rules/m7-memory.mdc',
  ...MEMORY_BANK_FILES,
  'PROJECT_SCHEMA.yaml',
];

const MANAGED_TEMPLATES = [
  'memory-bank/activeContext.md',
  'MASTER_REFERENCE.md',
  'CODING_STANDARDS.md',
  'CYCLE_REGISTRY.md',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sha = buf => createHash('sha256').update(buf).digest('hex');
const foreignText = rel => `FOREIGN CONTENT of ${rel}. Owned by the user, not by M7.\n`;

async function seed(dir, rels, textOf = foreignText) {
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, typeof textOf === 'function' ? textOf(rel) : textOf);
  }
}

/** Throwaway directory with nothing in it. */
async function makeEmptyDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

const SKIP_TOP = new Set(['.m7', 'm7-cycles']);

/** Map of relative path -> sha256 (files) or 'dir' (directories); `.m7/` and `m7-cycles/` left out. */
async function snapshot(root) {
  const out = new Map();
  async function walk(rel) {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && SKIP_TOP.has(e.name)) continue;
      if (e.isDirectory()) {
        out.set(`${r}/`, 'dir');
        await walk(r);
      } else {
        out.set(r, sha(await readFile(path.join(root, r))));
      }
    }
  }
  await walk('');
  return out;
}

/** Pure: what changed between two snapshots. */
function diffSnapshots(before, after) {
  const added = [...after.keys()].filter(k => !before.has(k)).sort();
  const removed = [...before.keys()].filter(k => !after.has(k)).sort();
  const modified = [...before.keys()].filter(k => after.has(k) && after.get(k) !== before.get(k)).sort();
  return { added, removed, modified };
}

/** Files M7 owns under the project (`.m7/`, `m7-cycles/`), as a sorted list. */
async function m7OwnedFiles(root) {
  const out = [];
  async function walk(rel) {
    let entries;
    try { entries = await readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(r);
      else out.push(r);
    }
  }
  for (const top of SKIP_TOP) await walk(top);
  return out.sort();
}

/** Start the server on `dir`, make one tool call, let late writes land, stop the server. */
async function callTool(dir, name, args, { settleMs = 600 } = {}) {
  const s = await startServer(dir);
  try {
    const res = await s.call(name, args);
    await sleep(settleMs); // updateActiveContext is fire and forget; the journal flushes after 1 s
    return res;
  } finally {
    await s.stop('close');
  }
}

/** Section of a tool answer: from the first line matching `heading` to the end. */
function splitAtSkipped(text) {
  const m = /^#{2,3} .*Skipped.*$/m.exec(text);
  if (!m) return { created: text, skipped: '' };
  return { created: text.slice(0, m.index), skipped: text.slice(m.index) };
}

/** The part of an analyze_task answer that reports the task folder. */
function structureSection(text) {
  const i = text.indexOf('M7 Structure Auto-Created');
  if (i === -1) return '';
  const j = text.indexOf('Start with', i);
  return text.slice(i, j === -1 ? undefined : j);
}

/** Files the answer reports under docs/: [{ mark: '✅' | '⏭️', path }]. */
function reportedStructure(text) {
  return [...structureSection(text).matchAll(/^- (✅|⏭️) (docs\/\S+)/gm)].map(m => ({ mark: m[1], path: m[2] }));
}

const TASK_SLUG = 'add-retry-to-the-http-client-w_add-retry-to-the-http-client-w';

async function withDir(make, fn) {
  const dir = await make();
  try {
    return await fn(dir);
  } finally {
    await removeProject(dir);
  }
}

// ---------------------------------------------------------------------------
// analyze_task
// ---------------------------------------------------------------------------

describe('analyze_task in a project that has files', () => {
  it('analyze_task in a non-empty project writes only the task folder it reports', T, async () => {
    await withDir(() => makeProject('sec-nonempty-'), async dir => {
      const userFiles = ['README.md', 'src/app.js', 'docs/guide.md', 'docs/debug/older-task/DISCOVERY_REPORT.md'];
      await seed(dir, userFiles);
      const before = await snapshot(dir);

      const res = await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK });
      assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);

      const d = diffSnapshots(before, await snapshot(dir));
      console.log(`[inventory] non-empty project, files M7 owns after analyze_task: ${JSON.stringify(await m7OwnedFiles(dir))}`);
      console.log(`[inventory] non-empty project, project files changed: ${JSON.stringify(d)}`);
      assert.deepEqual(d.modified, [], `analyze_task changed existing files:\n${d.modified.join('\n')}`);
      assert.deepEqual(d.removed, [], `analyze_task removed files:\n${d.removed.join('\n')}`);

      // The files it adds are exactly the files it reports.
      const reported = reportedStructure(res.text).map(r => r.path).sort();
      assert.ok(reported.length > 0, `the answer reports no task folder:\n${res.text.slice(0, 600)}`);
      const addedFiles = d.added.filter(p => !p.endsWith('/'));
      const addedDirs = d.added.filter(p => p.endsWith('/'));
      assert.deepEqual(addedFiles, reported, 'added files must equal the files the answer reports');

      // All of them sit in one docs/debug|features/<folder>/.
      const folders = new Set(reported.map(p => /^(docs\/(?:debug|features)\/[^/]+)\/[^/]+$/.exec(p)?.[1]));
      assert.equal(folders.size, 1, `reported files must share one task folder: ${[...folders].join(', ')}`);
      assert.ok(!folders.has(undefined), `a reported path is not docs/debug|features/<folder>/<file>: ${reported.join(', ')}`);

      // Every added directory leads to a reported file.
      for (const dirEntry of addedDirs) {
        assert.ok(reported.some(p => p.startsWith(dirEntry)), `added directory ${dirEntry} holds no reported file`);
      }

      // The user's own files, also under docs/, stay as they were.
      for (const rel of userFiles) {
        assert.equal(await readFile(path.join(dir, rel), 'utf8'), foreignText(rel), `${rel} changed`);
      }
    });
  });

  it('analyze_task in a non-empty project without M7 files points to mcp_m7_init_project', T, async () => {
    await withDir(() => makeProject('sec-note-'), async dir => {
      await seed(dir, ['README.md']);
      const res = await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK });
      assert.match(res.text, /mcp_m7_init_project/, 'the answer must point to mcp_m7_init_project');
    });
  });

  // A project whose only files are hidden is still a project: .github, .vscode and .env are the
  // user's, and a .cursorrules plus an alwaysApply rule would change how the agent behaves.
  const HIDDEN_ONLY = ['.github/workflows/ci.yml', '.vscode/settings.json', '.env'];

  it('analyze_task in a directory with only .github, .vscode and .env writes nothing', T, async () => {
    await withDir(() => makeEmptyDir('sec-hidden-only-'), async dir => {
      await seed(dir, HIDDEN_ONLY);
      const before = await snapshot(dir);

      const res = await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK, create_session: false });
      assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);

      const d = diffSnapshots(before, await snapshot(dir));
      assert.deepEqual(d, { added: [], removed: [], modified: [] }, `analyze_task changed a directory that holds only hidden project files:\n${JSON.stringify(d, null, 1)}`);
      assert.ok(!/Cold Start/.test(res.text), 'the answer reports a cold start');
      assert.match(res.text, /mcp_m7_init_project/, 'the answer must point to mcp_m7_init_project');
    });
  });

  it('analyze_task in a directory with only .github, .vscode and .env sets no M7 file up, also with a task folder', T, async () => {
    await withDir(() => makeEmptyDir('sec-hidden-only-session-'), async dir => {
      await seed(dir, HIDDEN_ONLY);
      const before = await snapshot(dir);

      const res = await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK });
      assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);

      const d = diffSnapshots(before, await snapshot(dir));
      assert.deepEqual(d.modified, [], `analyze_task changed existing files:\n${d.modified.join('\n')}`);
      assert.deepEqual(d.removed, [], `analyze_task removed files:\n${d.removed.join('\n')}`);
      const reported = reportedStructure(res.text).map(r => r.path).sort();
      assert.deepEqual(d.added.filter(p => !p.endsWith('/')), reported, 'the only files added are the ones the answer reports');
      for (const rel of SEEDED_BY_INIT) {
        assert.ok(!existsSync(path.join(dir, rel)), `${rel} was created in a directory that holds only hidden project files`);
      }
      assert.ok(!existsSync(path.join(dir, '.cursor')), '.cursor/ was created');
      assert.ok(!existsSync(path.join(dir, 'memory-bank')), 'memory-bank/ was created');
    });
  });

  it('init_project without force refuses a directory with only .github, .vscode and .env', T, async () => {
    await withDir(() => makeEmptyDir('sec-hidden-only-init-'), async dir => {
      await seed(dir, HIDDEN_ONLY);
      const before = await snapshot(dir);

      const res = await callTool(dir, 'mcp_m7_init_project', {});
      assert.equal(res.isError, true, `init_project must refuse:\n${res.text.slice(0, 400)}`);
      assert.match(res.text, /Not Empty/i);
      const d = diffSnapshots(before, await snapshot(dir));
      assert.deepEqual(d, { added: [], removed: [], modified: [] }, `init_project wrote files:\n${JSON.stringify(d, null, 1)}`);
    });
  });

  it('analyze_task leaves a foreign memory-bank/activeContext.md alone', T, async () => {
    await withDir(() => makeProject('sec-foreign-ctx-'), async dir => {
      await seed(dir, ['memory-bank/activeContext.md']);
      const file = path.join(dir, 'memory-bank/activeContext.md');
      const before = await readFile(file);

      const res = await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK });
      assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);

      const after = await readFile(file);
      assert.equal(after.toString(), before.toString(), 'memory-bank/activeContext.md was overwritten');
    });
  });

  it('analyze_task updates an activeContext.md that carries the M7 marker and keeps the marker', T, async () => {
    await withDir(() => makeProject('sec-managed-ctx-'), async dir => {
      await seed(dir, ['memory-bank/activeContext.md'], `${MARKER}\n# Active Context\n\nOLD TEXT\n`);
      await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK });

      const after = await readFile(path.join(dir, 'memory-bank/activeContext.md'), 'utf8');
      assert.ok(after.includes(TASK.slice(0, 40)), `the update did not land:\n${after}`);
      assert.ok(!after.includes('OLD TEXT'), 'the old text is still there');
      assert.ok(after.includes(MARKER), 'the update dropped the M7 marker');
    });
  });
});

describe('analyze_task in an empty directory', () => {
  it('analyze_task in an empty directory creates files and lists them', T, async () => {
    await withDir(() => makeEmptyDir('sec-empty-'), async dir => {
      const res = await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK });
      assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);

      for (const rel of SEEDED_BY_INIT.filter(r => r !== 'PROJECT_SCHEMA.yaml')) {
        assert.ok(existsSync(path.join(dir, rel)), `${rel} was not created`);
      }

      assert.match(res.text, /Cold Start/, 'the answer has no Cold Start section');
      const count = /Создано файлов:\*\* (\d+)/.exec(res.text);
      assert.ok(count && Number(count[1]) >= SEEDED_BY_INIT.length - 1, `created-file count: ${count && count[1]}`);

      // Every listed path that is a plain file path exists on disk.
      const listed = [...res.text.matchAll(/^- ✅ (\S+)$/gm)].map(m => m[1]).filter(p => !p.endsWith('/'));
      assert.ok(listed.length > 0, 'the Cold Start section lists no file');
      for (const p of listed) {
        if (p.includes(':')) continue; // 'UnifiedMemory: ...' is not a path
        assert.ok(existsSync(path.join(dir, p)), `listed but not on disk: ${p}`);
      }

      // Nothing existed before, so nothing was skipped.
      assert.ok(!/^#{2,3} .*Skipped/m.test(res.text), 'a fresh directory must have no Skipped section');
    });
  });

  it('files created in an empty directory carry the M7 marker where M7 appends later', T, async () => {
    await withDir(() => makeEmptyDir('sec-marker-'), async dir => {
      await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK });
      for (const rel of MANAGED_TEMPLATES) {
        const head = (await readFile(path.join(dir, rel))).subarray(0, 4096).toString('utf8');
        assert.ok(head.includes(MARKER), `${rel} has no ${MARKER} in its first 4 KB`);
      }
    });
  });

  // CHANGED on purpose. This test used to be 'analyze_task in a directory holding only a hidden
  // .cursorrules keeps it and lists it as skipped'. It expected the cold start to run in that
  // directory and to skip the one file that exists. That pinned the bug: a hidden name such as
  // .cursorrules, .github, .vscode or .env is the user's, so a directory that holds one is not
  // empty. The cold start must not run there at all, so nothing is skipped and nothing is created.
  it('analyze_task in a directory holding only a hidden .cursorrules does not set the project up and keeps the file', T, async () => {
    await withDir(() => makeEmptyDir('sec-hidden-'), async dir => {
      await seed(dir, ['.cursorrules']);
      const res = await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK, create_session: false });

      assert.equal(await readFile(path.join(dir, '.cursorrules'), 'utf8'), foreignText('.cursorrules'), '.cursorrules was overwritten');
      assert.ok(!/Cold Start/.test(res.text), 'the cold start ran in a directory that holds a .cursorrules');
      const written = (await readdir(dir)).filter(n => !SKIP_TOP.has(n));
      assert.deepEqual(written, ['.cursorrules'], `analyze_task wrote files next to the user's .cursorrules: ${written.join(', ')}`);
    });
  });
});

// ---------------------------------------------------------------------------
// init_project
// ---------------------------------------------------------------------------

describe('init_project with force', () => {
  it('init_project with force keeps every existing file and lists it as skipped', T, async () => {
    await withDir(() => makeEmptyDir('sec-force-all-'), async dir => {
      await seed(dir, SEEDED_BY_INIT);
      const before = await snapshot(dir);

      const res = await callTool(dir, 'mcp_m7_init_project', { force: true });
      assert.ok(!res.isError, `init_project failed:\n${res.text.slice(0, 400)}`);

      const d = diffSnapshots(before, await snapshot(dir));
      assert.deepEqual(d.modified, [], `existing files were overwritten:\n${d.modified.join('\n')}`);
      assert.deepEqual(d.removed, [], `existing files were removed:\n${d.removed.join('\n')}`);
      for (const rel of SEEDED_BY_INIT) {
        assert.equal(await readFile(path.join(dir, rel), 'utf8'), foreignText(rel), `${rel} changed`);
      }

      const { created, skipped } = splitAtSkipped(res.text);
      assert.ok(skipped, `the answer has no Skipped section:\n${res.text.slice(0, 600)}`);
      for (const rel of SEEDED_BY_INIT) {
        assert.ok(skipped.includes(`**${rel}**`), `${rel} is not listed as skipped`);
        assert.ok(!created.includes(`**${rel}**`), `${rel} is listed as created`);
      }
    });
  });

  it('init_project with force creates what is missing and skips only what exists', T, async () => {
    await withDir(() => makeEmptyDir('sec-force-part-'), async dir => {
      const have = ['README.md', 'memory-bank/activeContext.md'];
      await seed(dir, have);

      const res = await callTool(dir, 'mcp_m7_init_project', { force: true });
      assert.ok(!res.isError, `init_project failed:\n${res.text.slice(0, 400)}`);

      const { created, skipped } = splitAtSkipped(res.text);
      for (const rel of have) {
        assert.equal(await readFile(path.join(dir, rel), 'utf8'), foreignText(rel), `${rel} changed`);
        assert.ok(skipped.includes(`**${rel}**`), `${rel} is not listed as skipped`);
        assert.ok(!created.includes(`**${rel}**`), `${rel} is listed as created`);
      }
      const missing = SEEDED_BY_INIT.filter(r => !have.includes(r));
      for (const rel of missing) {
        assert.ok(existsSync(path.join(dir, rel)), `${rel} was not created`);
        assert.ok(created.includes(`**${rel}**`), `${rel} is not listed as created`);
        assert.ok(!skipped.includes(`**${rel}**`), `${rel} is listed as skipped`);
      }
    });
  });

  it('init_project does not follow a dangling symlink named like a project file', T, async () => {
    await withDir(() => makeEmptyDir('sec-force-link-'), async dir => {
      const outside = await makeEmptyDir('sec-outside-');
      try {
        const target = path.join(outside, 'created-through-link.md');
        await symlink(target, path.join(dir, 'README.md'));

        await callTool(dir, 'mcp_m7_init_project', { force: true });
        assert.ok(!existsSync(target), 'init_project wrote through the symlink');
      } finally {
        await removeProject(outside);
      }
    });
  });

  it('init_project without force still refuses a non-empty directory and writes nothing', T, async () => {
    await withDir(() => makeProject('sec-noforce-'), async dir => {
      await seed(dir, ['README.md']);
      const before = await snapshot(dir);
      const res = await callTool(dir, 'mcp_m7_init_project', {});
      assert.equal(res.isError, true);
      assert.match(res.text, /Directory Not Empty/);
      assert.deepEqual(diffSnapshots(before, await snapshot(dir)), { added: [], removed: [], modified: [] });
    });
  });
});

// ---------------------------------------------------------------------------
// memory store: the bridge to reference files
// ---------------------------------------------------------------------------

describe('memory store_at bridge to reference files', () => {
  const DECISION = {
    action: 'store_at',
    level: 'L2',
    context_keys: ['decision'],
    content: 'Decision: keep the registry append-only because the audit needs the order.',
  };

  it('memory store does not append to a file it does not manage', T, async () => {
    await withDir(() => makeProject('sec-bridge-foreign-'), async dir => {
      await seed(dir, ['CYCLE_REGISTRY.md']);
      const res = await callTool(dir, 'mcp_m7_memory', DECISION);
      assert.ok(!res.isError, `memory failed:\n${res.text.slice(0, 400)}`);

      assert.equal(await readFile(path.join(dir, 'CYCLE_REGISTRY.md'), 'utf8'), foreignText('CYCLE_REGISTRY.md'), 'CYCLE_REGISTRY.md was appended to');
      assert.match(res.text, /not synced/i, 'the answer must say the entry was not synced');
      assert.ok(!/Also synced to/.test(res.text), 'the answer claims a sync that did not happen');
    });
  });

  it('memory store does not create a reference file that is missing', T, async () => {
    await withDir(() => makeProject('sec-bridge-absent-'), async dir => {
      const res = await callTool(dir, 'mcp_m7_memory', DECISION);
      assert.ok(!existsSync(path.join(dir, 'CYCLE_REGISTRY.md')), 'CYCLE_REGISTRY.md was created');
      assert.match(res.text, /not synced/i);
    });
  });

  it('memory store appends to a file that carries the M7 marker in its first 4 KB', T, async () => {
    await withDir(() => makeProject('sec-bridge-managed-'), async dir => {
      const base = `${MARKER}\n# Cycle Registry\n`;
      await seed(dir, ['CYCLE_REGISTRY.md'], base);
      const res = await callTool(dir, 'mcp_m7_memory', DECISION);

      const after = await readFile(path.join(dir, 'CYCLE_REGISTRY.md'), 'utf8');
      assert.ok(after.startsWith(base), 'the existing text must stay in front');
      assert.ok(after.includes(DECISION.content.slice(0, 40)), `the entry was not appended:\n${after}`);
      assert.match(res.text, /Also synced to CYCLE_REGISTRY\.md/);
    });
  });

  it('memory store does not append when the marker lies beyond the first 4 KB', T, async () => {
    await withDir(() => makeProject('sec-bridge-late-'), async dir => {
      const late = `# Notes\n${'x'.repeat(4200)}\n${MARKER}\n`;
      await seed(dir, ['CYCLE_REGISTRY.md'], late);
      const res = await callTool(dir, 'mcp_m7_memory', DECISION);

      assert.equal(await readFile(path.join(dir, 'CYCLE_REGISTRY.md'), 'utf8'), late, 'the file was appended to');
      assert.match(res.text, /not synced/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Task folders: docs/debug|features/<folder>/ (amendment to 2.1)
// ---------------------------------------------------------------------------

describe('task folder files are never replaced', () => {
  it('analyze_task keeps an edited file in an existing task folder and reports it as kept', T, async () => {
    await withDir(() => makeProject('sec-taskdir-'), async dir => {
      // The route decides debug or features; seed both so the test does not depend on it.
      const edited = [`docs/debug/${TASK_SLUG}/DISCOVERY_REPORT.md`, `docs/features/${TASK_SLUG}/DISCOVERY_REPORT.md`];
      await seed(dir, edited);

      const res = await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK });
      assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);

      for (const rel of edited) {
        assert.equal(await readFile(path.join(dir, rel), 'utf8'), foreignText(rel), `${rel} was overwritten`);
      }

      const reported = reportedStructure(res.text);
      // The seven template files and TASK_META.json, which the task graph writes into the task folder.
      assert.equal(reported.length, 8, `expected 8 reported files:\n${JSON.stringify(reported)}`);
      const taskMeta = reported.filter(r => r.path.endsWith('/TASK_META.json'));
      assert.equal(taskMeta.length, 1, `expected one TASK_META.json:\n${JSON.stringify(reported)}`);
      assert.equal(taskMeta[0].mark, '✅', 'a TASK_META.json that M7 wrote must be reported as created');
      const discovery = reported.filter(r => r.path.endsWith('/DISCOVERY_REPORT.md'));
      assert.equal(discovery.length, 1);
      assert.equal(discovery[0].mark, '⏭️', 'the kept file must be reported as kept, not as created');
      assert.ok(edited.includes(discovery[0].path), `kept file is not the edited one: ${discovery[0].path}`);
      for (const r of reported.filter(x => x !== discovery[0])) {
        assert.equal(r.mark, '✅', `${r.path} should be reported as created`);
        assert.ok(existsSync(path.join(dir, r.path)), `${r.path} is reported but not on disk`);
      }
    });
  });

  it('analyze_task keeps an existing TASK_META.json in the task folder and reports it as kept', T, async () => {
    await withDir(() => makeProject('sec-taskmeta-'), async dir => {
      // The route decides debug or features; seed both so the test does not depend on it.
      const edited = [`docs/debug/${TASK_SLUG}/TASK_META.json`, `docs/features/${TASK_SLUG}/TASK_META.json`];
      await seed(dir, edited);

      const res = await callTool(dir, 'mcp_m7_analyze_task', { task_description: TASK });
      assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);

      for (const rel of edited) {
        assert.equal(await readFile(path.join(dir, rel), 'utf8'), foreignText(rel), `${rel} was overwritten`);
      }

      const taskMeta = reportedStructure(res.text).filter(r => r.path.endsWith('/TASK_META.json'));
      assert.equal(taskMeta.length, 1, `expected one TASK_META.json in the answer:\n${JSON.stringify(taskMeta)}`);
      assert.equal(taskMeta[0].mark, '⏭️', 'the kept file must be reported as kept, not as created');
      assert.ok(edited.includes(taskMeta[0].path), `kept file is not the edited one: ${taskMeta[0].path}`);
    });
  });

  it('create_structure keeps an existing file and reports it', T, async () => {
    await withDir(() => makeProject('sec-create-structure-'), async dir => {
      const kept = 'docs/debug/sec-task_probe/SOLUTION_PLAN.md';
      await seed(dir, [kept]);

      const res = await callTool(dir, 'mcp_m7_create_structure', { task_id: 'sec-task', route: 'medium', description: 'probe' });
      assert.ok(!res.isError, `create_structure failed:\n${res.text.slice(0, 400)}`);

      assert.equal(await readFile(path.join(dir, kept), 'utf8'), foreignText(kept), `${kept} was overwritten`);
      const lines = res.text.split('\n').filter(l => /^- (✅|⏭️) \*\*docs\//.test(l));
      assert.equal(lines.length, 7, `expected 7 reported files:\n${lines.join('\n')}`);
      const keptLine = lines.find(l => l.includes('SOLUTION_PLAN.md'));
      assert.ok(keptLine && keptLine.startsWith('- ⏭️'), `SOLUTION_PLAN.md must be reported as kept: ${keptLine}`);
      for (const l of lines.filter(x => x !== keptLine)) assert.ok(l.startsWith('- ✅'), `should be created: ${l}`);
      assert.ok(existsSync(path.join(dir, 'docs/debug/sec-task_probe/DISCOVERY_REPORT.md')), 'the other files must still be created');
    });
  });
});

// ---------------------------------------------------------------------------
// memory: store_pattern and update_project bridges (amendment to 2.1)
// ---------------------------------------------------------------------------

describe('memory store_pattern bridge to CODING_STANDARDS.md', () => {
  const PATTERN = {
    action: 'store_pattern',
    pattern: { name: 'retry-with-backoff', description: 'Retry failed calls with backoff', tags: ['retry'] },
  };

  it('store_pattern does not append to a foreign CODING_STANDARDS.md', T, async () => {
    await withDir(() => makeProject('sec-pattern-foreign-'), async dir => {
      await seed(dir, ['CODING_STANDARDS.md']);
      const res = await callTool(dir, 'mcp_m7_memory', PATTERN);
      assert.ok(!res.isError, `memory failed:\n${res.text.slice(0, 400)}`);
      assert.equal(await readFile(path.join(dir, 'CODING_STANDARDS.md'), 'utf8'), foreignText('CODING_STANDARDS.md'), 'CODING_STANDARDS.md was appended to');
      assert.match(res.text, /not synced/i);
      assert.ok(!/Also synced/.test(res.text), 'the answer claims a sync that did not happen');
    });
  });

  it('store_pattern does not create a missing CODING_STANDARDS.md', T, async () => {
    await withDir(() => makeProject('sec-pattern-absent-'), async dir => {
      const res = await callTool(dir, 'mcp_m7_memory', PATTERN);
      assert.ok(!existsSync(path.join(dir, 'CODING_STANDARDS.md')), 'CODING_STANDARDS.md was created');
      assert.match(res.text, /not synced/i);
    });
  });

  it('store_pattern appends to a managed CODING_STANDARDS.md', T, async () => {
    await withDir(() => makeProject('sec-pattern-managed-'), async dir => {
      const base = `${MARKER}\n# Standards\n`;
      await seed(dir, ['CODING_STANDARDS.md'], base);
      const res = await callTool(dir, 'mcp_m7_memory', PATTERN);
      const after = await readFile(path.join(dir, 'CODING_STANDARDS.md'), 'utf8');
      assert.ok(after.startsWith(base), 'the existing text must stay in front');
      assert.ok(after.includes('### retry-with-backoff'), `the pattern was not appended:\n${after}`);
      assert.match(res.text, /Also synced to CODING_STANDARDS\.md/);
    });
  });
});

describe('memory update_project bridge to MASTER_REFERENCE.md', () => {
  const HEADING = '## Project Metadata (auto-synced)';
  const update = name => ({
    action: 'update_project',
    project: { name, description: `${name} description` },
  });

  it('update_project does not change a foreign MASTER_REFERENCE.md without the metadata heading', T, async () => {
    await withDir(() => makeProject('sec-meta-foreign-'), async dir => {
      await seed(dir, ['MASTER_REFERENCE.md']);
      const res = await callTool(dir, 'mcp_m7_memory', update('theirs'));
      assert.ok(!res.isError, `memory failed:\n${res.text.slice(0, 400)}`);
      assert.equal(await readFile(path.join(dir, 'MASTER_REFERENCE.md'), 'utf8'), foreignText('MASTER_REFERENCE.md'), 'MASTER_REFERENCE.md was changed');
      assert.match(res.text, /not synced/i);
      assert.ok(!/Also synced/.test(res.text), 'the answer claims a sync that did not happen');
    });
  });

  it('update_project does not change a foreign MASTER_REFERENCE.md that has the metadata heading', T, async () => {
    await withDir(() => makeProject('sec-meta-foreign-heading-'), async dir => {
      const theirs = `# Our reference\n\n${HEADING}\n- **Name:** theirs\n\n## Later\nkeep\n`;
      await seed(dir, ['MASTER_REFERENCE.md'], theirs);
      const res = await callTool(dir, 'mcp_m7_memory', update('mine'));
      assert.equal(await readFile(path.join(dir, 'MASTER_REFERENCE.md'), 'utf8'), theirs, 'MASTER_REFERENCE.md was rewritten');
      assert.match(res.text, /not synced/i);
    });
  });

  it('update_project does not create a missing MASTER_REFERENCE.md', T, async () => {
    await withDir(() => makeProject('sec-meta-absent-'), async dir => {
      const res = await callTool(dir, 'mcp_m7_memory', update('mine'));
      assert.ok(!existsSync(path.join(dir, 'MASTER_REFERENCE.md')), 'MASTER_REFERENCE.md was created');
      assert.match(res.text, /not synced/i);
    });
  });

  it('update_project replaces its section in a managed file and keeps the marker and later sections', T, async () => {
    await withDir(() => makeProject('sec-meta-managed-'), async dir => {
      const seeded = `${MARKER}\n# Master\n\n${HEADING}\n- **Name:** old\n- **Synced:** 2020-01-01\n\n## Later Section\nKEEP ME\n`;
      await seed(dir, ['MASTER_REFERENCE.md'], seeded);

      for (const name of ['first-run', 'second-run']) {
        const res = await callTool(dir, 'mcp_m7_memory', update(name));
        assert.match(res.text, /Also synced to MASTER_REFERENCE\.md/, `${name}: no sync reported`);
      }

      const after = await readFile(path.join(dir, 'MASTER_REFERENCE.md'), 'utf8');
      assert.ok(after.startsWith(`${MARKER}\n# Master`), 'the marker and the start of the file must stay');
      assert.equal(after.split(HEADING).length - 1, 1, `the metadata heading must appear once:\n${after}`);
      assert.ok(after.includes('second-run'), 'the second run did not land');
      assert.ok(!after.includes('first-run'), 'the first run was not replaced');
      assert.ok(!after.includes('**Name:** old'), 'the old section was not replaced');
      assert.ok(after.includes('## Later Section\nKEEP ME'), 'the later section was lost');
    });
  });
});

// ---------------------------------------------------------------------------
// init_project with an explicit project_path: schema and journal follow the path
// ---------------------------------------------------------------------------

describe('init_project with an explicit project_path', () => {
  it('init_project with explicit project_path leaves the old root\'s PROJECT_SCHEMA.yaml byte-identical and writes the schema to the new root', T, async () => {
    await withDir(() => makeProject('sec-oldroot-'), async oldRoot => {
      await withDir(() => makeEmptyDir('sec-newroot-'), async newRoot => {
        await seed(oldRoot, ['PROJECT_SCHEMA.yaml']);
        const res = await callTool(oldRoot, 'mcp_m7_init_project', { project_path: newRoot }, { settleMs: 1600 });
        assert.ok(!res.isError, `init_project failed:\n${res.text.slice(0, 400)}`);

        assert.equal(await readFile(path.join(oldRoot, 'PROJECT_SCHEMA.yaml'), 'utf8'), foreignText('PROJECT_SCHEMA.yaml'), 'the old root\'s PROJECT_SCHEMA.yaml was overwritten');
        const written = path.join(newRoot, 'PROJECT_SCHEMA.yaml');
        assert.ok(existsSync(written), 'PROJECT_SCHEMA.yaml was not written to the new root');
        assert.ok((await readFile(written, 'utf8')).includes(path.basename(newRoot)), 'the new schema does not name the new project');
      });
    });
  });

  it('init_project with explicit project_path writes its journal entry under the new root only', T, async () => {
    await withDir(() => makeProject('sec-oldroot-j-'), async oldRoot => {
      await withDir(() => makeEmptyDir('sec-newroot-j-'), async newRoot => {
        await callTool(oldRoot, 'mcp_m7_init_project', { project_path: newRoot }, { settleMs: 1600 });

        const read = async root => {
          try { return await readFile(path.join(root, '.m7', 'features.json'), 'utf8'); } catch { return ''; }
        };
        const entries = ['M7 Ecosystem Initialization', 'schema-updated'];
        const inNew = await read(newRoot);
        const inOld = await read(oldRoot);
        for (const name of entries) {
          assert.ok(inNew.includes(name), `journal entry "${name}" is missing under the new root`);
          assert.ok(!inOld.includes(name), `journal entry "${name}" was written under the old root`);
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Pure decision functions (a t27 port is planned, not done)
// ---------------------------------------------------------------------------

const loadSafeWrite = () => import(path.join(DIST, 'core/utils/safeWrite.js'));
const loadInitProject = () => import(path.join(DIST, 'core/tools/initProject.js'));

describe('safeWrite: pure rules', () => {
  it('hasManagedMarker looks at the first 4096 bytes only', async () => {
    const { hasManagedMarker, M7_MANAGED_MARKER } = await loadSafeWrite();
    assert.equal(M7_MANAGED_MARKER, MARKER);
    assert.equal(hasManagedMarker(''), false);
    assert.equal(hasManagedMarker(`${MARKER}\nbody`), true);
    assert.equal(hasManagedMarker(`# Title\n${MARKER}\n`), true);
    assert.equal(hasManagedMarker('<!-- m7-managed'), false, 'a partial marker is no marker');

    const endsAt4096 = 'a'.repeat(4096 - MARKER.length) + MARKER;
    assert.equal(Buffer.byteLength(endsAt4096), 4096);
    assert.equal(hasManagedMarker(endsAt4096), true, 'marker that ends at byte 4096 counts');

    const startsAt4096 = 'a'.repeat(4096) + MARKER;
    assert.equal(hasManagedMarker(startsAt4096), false, 'marker that starts at byte 4096 does not count');

    const straddles = 'a'.repeat(4090) + MARKER;
    assert.equal(hasManagedMarker(straddles), false, 'marker cut by byte 4096 does not count');

    // Bytes, not characters: 3000 two-byte characters fill 6000 bytes.
    assert.equal(hasManagedMarker('é'.repeat(3000) + MARKER), false);
  });

  it('managedStateOf maps a missing file to absent, a marked file to managed, anything else to foreign', async () => {
    const { managedStateOf } = await loadSafeWrite();
    assert.equal(managedStateOf(null), 'absent');
    assert.equal(managedStateOf(Buffer.from(`${MARKER}\nx`)), 'managed');
    assert.equal(managedStateOf(Buffer.from('# user text\n')), 'foreign');
    assert.equal(managedStateOf(Buffer.alloc(0)), 'foreign');
  });

  it('managedWriteAction: create when absent, update when managed, skip when foreign', async () => {
    const { managedWriteAction } = await loadSafeWrite();
    assert.equal(managedWriteAction('absent'), 'create');
    assert.equal(managedWriteAction('managed'), 'update');
    assert.equal(managedWriteAction('foreign'), 'skip');
  });

  it('managedSyncAction: sync only for a managed file', async () => {
    const { managedSyncAction } = await loadSafeWrite();
    assert.equal(managedSyncAction('managed'), 'sync');
    assert.equal(managedSyncAction('absent'), 'skip');
    assert.equal(managedSyncAction('foreign'), 'skip');
  });

  it('updateIfManaged rewrites a managed file with the transform and leaves every other file alone', async () => {
    const { updateIfManaged } = await loadSafeWrite();
    await withDir(() => makeEmptyDir('sec-uim-'), async dir => {
      const managed = path.join(dir, 'm.md');
      const foreign = path.join(dir, 'f.md');
      await writeFile(managed, `${MARKER}\nold`);
      await writeFile(foreign, 'old');
      assert.equal(await updateIfManaged(managed, text => text.replace('old', 'new')), 'updated');
      assert.equal(await readFile(managed, 'utf8'), `${MARKER}\nnew`);
      assert.equal(await updateIfManaged(foreign, () => 'x'), 'not-synced');
      assert.equal(await readFile(foreign, 'utf8'), 'old');
      assert.equal(await updateIfManaged(path.join(dir, 'none.md'), () => 'x'), 'not-synced');
      assert.ok(!existsSync(path.join(dir, 'none.md')));
    });
  });

  it('writeIfAbsent creates a new file, then skips and keeps the old bytes', async () => {
    const { writeIfAbsent } = await loadSafeWrite();
    await withDir(() => makeEmptyDir('sec-wia-'), async dir => {
      const f = path.join(dir, 'a.md');
      assert.equal(await writeIfAbsent(f, 'first'), 'created');
      assert.equal(await writeIfAbsent(f, 'second'), 'skipped');
      assert.equal(await readFile(f, 'utf8'), 'first');
    });
  });

  it('writeIfAbsent skips a symlink, even a dangling one, and writes nothing through it', async () => {
    const { writeIfAbsent } = await loadSafeWrite();
    await withDir(() => makeEmptyDir('sec-wia-link-'), async dir => {
      const target = path.join(dir, 'target.md');
      const link = path.join(dir, 'link.md');
      await symlink(target, link);
      assert.equal(await writeIfAbsent(link, 'x'), 'skipped');
      assert.ok(!existsSync(target));
    });
  });

  it('writeIfAbsent rethrows an error that is not "file exists"', async () => {
    const { writeIfAbsent } = await loadSafeWrite();
    await withDir(() => makeEmptyDir('sec-wia-err-'), async dir => {
      await assert.rejects(() => writeIfAbsent(path.join(dir, 'no-such-dir', 'a.md'), 'x'), { code: 'ENOENT' });
    });
  });

  it('readManagedState reads absent, managed, foreign and symlink from disk', async () => {
    const { readManagedState } = await loadSafeWrite();
    await withDir(() => makeEmptyDir('sec-rms-'), async dir => {
      await writeFile(path.join(dir, 'm.md'), `${MARKER}\nx`);
      await writeFile(path.join(dir, 'f.md'), 'user text');
      await symlink(path.join(dir, 'm.md'), path.join(dir, 'link.md'));
      assert.equal(await readManagedState(path.join(dir, 'none.md')), 'absent');
      assert.equal(await readManagedState(path.join(dir, 'm.md')), 'managed');
      assert.equal(await readManagedState(path.join(dir, 'f.md')), 'foreign');
      assert.equal(await readManagedState(path.join(dir, 'link.md')), 'foreign', 'a symlink is never managed');
      assert.equal(await readManagedState(dir), 'foreign', 'a directory is never managed');
    });
  });
});

describe('initProject: pure rules and directory checks', () => {
  // CHANGED on purpose. This test used to be 'isEmptyListing ignores hidden names and counts every
  // other name', and it asserted that ['.git', '.cursorrules', '.DS_Store'] is empty. That pinned the
  // bug: every name that starts with a dot was ignored, so a directory with only .github, .vscode or
  // .env counted as empty and got a cold start. Empty now means only .git, .gitignore, .DS_Store and .m7.
  it('isEmptyListing ignores only .git, .gitignore, .DS_Store and .m7', async () => {
    const { isEmptyListing } = await loadInitProject();
    assert.equal(isEmptyListing([]), true);
    assert.equal(isEmptyListing(['.git']), true);
    assert.equal(isEmptyListing(['.git', '.gitignore', '.DS_Store', '.m7']), true);
    assert.equal(isEmptyListing(['.m7', '.DS_Store']), true);
    assert.equal(isEmptyListing(['.git', '.cursorrules', '.DS_Store']), false, '.cursorrules is the user\'s file');
    for (const name of ['.github', '.vscode', '.env', '.cursorrules', '.cursor', '.claude', '.npmrc', '.gitattributes', '.eslintrc', '.hidden']) {
      assert.equal(isEmptyListing([name]), false, `${name} alone must make the directory non-empty`);
      assert.equal(isEmptyListing(['.git', name]), false, `${name} next to .git must make the directory non-empty`);
    }
    assert.equal(isEmptyListing(['.github', '.vscode', '.env']), false);
    assert.equal(isEmptyListing(['package.json']), false);
    assert.equal(isEmptyListing(['src']), false);
    assert.equal(isEmptyListing(['.git', 'README.md']), false);
    // Names are compared exactly: a look-alike is a different file.
    assert.equal(isEmptyListing(['.GIT']), false);
    assert.equal(isEmptyListing(['.gitignore.bak']), false);
  });

  it('needsInitNoteFor is true only for a non-empty directory with neither memory-bank nor .cursorrules', async () => {
    const { needsInitNoteFor } = await loadInitProject();
    const f = (isEmpty, hasMemoryBank, hasCursorRules) => needsInitNoteFor({ isEmpty, hasMemoryBank, hasCursorRules });
    assert.equal(f(true, false, false), false);
    assert.equal(f(true, true, true), false);
    assert.equal(f(false, false, false), true);
    assert.equal(f(false, true, false), false);
    assert.equal(f(false, false, true), false);
    assert.equal(f(false, true, true), false);
  });

  it('needsM7Init is true only for an empty directory', async () => {
    const { needsM7Init } = await loadInitProject();
    await withDir(() => makeEmptyDir('sec-needs-'), async dir => {
      assert.equal(await needsM7Init(dir), true, 'empty directory');
      await mkdir(path.join(dir, '.git'));
      await writeFile(path.join(dir, '.gitignore'), 'node_modules\n');
      assert.equal(await needsM7Init(dir), true, 'only hidden entries');
      await writeFile(path.join(dir, 'package.json'), '{}');
      assert.equal(await needsM7Init(dir), false, 'a package.json makes it a real project');
    });
    await withDir(() => makeEmptyDir('sec-needs2-'), async dir => {
      await mkdir(path.join(dir, 'src'));
      assert.equal(await needsM7Init(dir), false, 'a source directory makes it a real project');
    });
  });

  it('needsM7Init and isDirectoryEmpty are false for a directory with only hidden project files', async () => {
    const { needsM7Init, isDirectoryEmpty } = await loadInitProject();
    await withDir(() => makeEmptyDir('sec-needs-hidden-'), async dir => {
      await mkdir(path.join(dir, '.github'));
      await mkdir(path.join(dir, '.vscode'));
      await writeFile(path.join(dir, '.env'), 'KEY=value\n');
      assert.equal(await needsM7Init(dir), false, '.github, .vscode and .env make it a real project');
      assert.equal(await isDirectoryEmpty(dir), false);
    });
    await withDir(() => makeEmptyDir('sec-needs-m7-'), async dir => {
      await mkdir(path.join(dir, '.m7'));
      await mkdir(path.join(dir, '.git'));
      await writeFile(path.join(dir, '.DS_Store'), '');
      assert.equal(await needsM7Init(dir), true, '.m7, .git and .DS_Store do not make it a real project');
    });
  });

  it('needsM7Init and isDirectoryEmpty return false when the directory cannot be read', async () => {
    const { needsM7Init, isDirectoryEmpty } = await loadInitProject();
    await withDir(() => makeEmptyDir('sec-unreadable-'), async dir => {
      const missing = path.join(dir, 'does-not-exist');
      assert.equal(await isDirectoryEmpty(missing), false);
      assert.equal(await needsM7Init(missing), false);
    });
  });
});

describe('memoryTool: mergeMetadataSection', () => {
  const HEADING = '## Project Metadata (auto-synced)';
  const SECTION = `\n${HEADING}\n- **Name:** new\n`;
  const load = () => import(path.join(DIST, 'core/tools/unified/memoryTool.js'));

  it('appends the section when the heading is absent', async () => {
    const { mergeMetadataSection } = await load();
    assert.equal(mergeMetadataSection('# Doc\n', SECTION), `# Doc\n${SECTION}`);
    assert.equal(mergeMetadataSection('', SECTION), SECTION);
  });

  it('replaces the section in the middle and keeps the text before and after it', async () => {
    const { mergeMetadataSection } = await load();
    const existing = `A\n${HEADING}\n- **Name:** old\n\n## Next\nB\n`;
    assert.equal(mergeMetadataSection(existing, SECTION), `A\n${HEADING}\n- **Name:** new\n\n## Next\nB\n`);
  });

  it('replaces the last section and is stable when applied twice', async () => {
    const { mergeMetadataSection } = await load();
    const existing = `A\n${HEADING}\n- **Name:** old\n`;
    const once = mergeMetadataSection(existing, SECTION);
    assert.equal(once, `A\n${HEADING}\n- **Name:** new\n`);
    assert.equal(mergeMetadataSection(once, SECTION), once);
  });
});
