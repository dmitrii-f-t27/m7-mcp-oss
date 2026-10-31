/**
 * SEC-7 (MEDIUM): path containment for the tools that write or read project files.
 *
 * Every server test starts the real MCP server (`node dist/index.js`) over stdio on a
 * throwaway project. The project sits one level down in a throwaway outer directory
 * (`<outer>/proj`, with `<outer>/outside` next to it), so a write that escapes the
 * project lands in the outer directory and not in the system temp directory.
 *
 * Tests that import a module added by this fix import it inside the test, so a
 * missing module fails only that test and never hides the server tests.
 *
 * Limit, stated on purpose: a path is checked, then used. A symlink swapped between
 * the check and the write is not caught.
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-write-paths.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DIST, bindProject, startServer } from './helpers/deepScanHarness.mjs';

const T = { timeout: 90_000 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const distUrl = rel => new URL(`file://${path.join(DIST, rel)}`).href;
const TASK = 'Add retry to the HTTP client wrapper in network layer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `<outer>/proj` (a project), `<outer>/outside` (empty, next to it). */
async function makeNested(prefix) {
  const outer = await mkdtemp(path.join(tmpdir(), prefix));
  const proj = path.join(outer, 'proj');
  const outside = path.join(outer, 'outside');
  await mkdir(proj);
  await mkdir(outside);
  await writeFile(path.join(proj, 'package.json'), JSON.stringify({ name: 'nested-fixture' }));
  return { outer, proj, outside };
}

async function withNested(fn) {
  const n = await makeNested('sec-paths-');
  try {
    return await fn(n);
  } finally {
    await rm(n.outer, { recursive: true, force: true });
  }
}

/** Start the server on `dir`, make one tool call, let late writes land, stop the server. */
async function callTool(dir, name, args, { settleMs = 400 } = {}) {
  const s = await startServer(dir);
  try {
    const res = await s.call(name, args);
    await sleep(settleMs);
    return res;
  } finally {
    await s.stop('close');
  }
}

/** Every entry under `root` as a sorted list of relative paths (symlinks are not followed). */
async function listTree(root) {
  const out = [];
  async function walk(rel) {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) await walk(r);
    }
  }
  await walk('');
  return out.sort();
}

// ---------------------------------------------------------------------------
// project_index
// ---------------------------------------------------------------------------

describe('project_index output_path', () => {
  const INDEX = { action: 'generate', include_git: false, force: true };

  it('project_index output_path outside the project is refused', T, async () => {
    await withNested(async ({ outer, proj, outside }) => {
      // An absolute path outside, and a relative path that climbs out.
      const abs = path.join(outside, 'INDEX.md');
      const rel = '../escaped-index.md';
      for (const output_path of [abs, rel]) {
        const res = await callTool(proj, 'mcp_m7_project_index', { ...INDEX, output_path });
        assert.match(res.text, /"success": false/, `output_path ${output_path} must be refused:\n${res.text.slice(0, 500)}`);
      }
      assert.ok(!existsSync(abs), 'project_index wrote an index outside the project (absolute path)');
      assert.ok(!existsSync(path.join(outer, 'escaped-index.md')), 'project_index wrote an index outside the project (relative path)');
    });
  });

  it('project_index output_path refuses a path through a symlink leaving the project', T, async () => {
    await withNested(async ({ proj, outside }) => {
      // Dangling link: the target does not exist yet. Existing target: needs force.
      await symlink(path.join(outside, 'dangling.md'), path.join(proj, 'dangling.md'));
      await writeFile(path.join(outside, 'existing.md'), 'OUTSIDE ORIGINAL');
      await symlink(path.join(outside, 'existing.md'), path.join(proj, 'existing.md'));
      await symlink(outside, path.join(proj, 'dir-link'));

      for (const output_path of ['dangling.md', 'existing.md', 'dir-link/INDEX.md']) {
        await callTool(proj, 'mcp_m7_project_index', { ...INDEX, output_path });
      }
      assert.ok(!existsSync(path.join(outside, 'dangling.md')), 'project_index wrote through a dangling symlink');
      assert.equal(await readFile(path.join(outside, 'existing.md'), 'utf8'), 'OUTSIDE ORIGINAL', 'project_index replaced a file outside the project through a symlink');
      assert.ok(!existsSync(path.join(outside, 'INDEX.md')), 'project_index wrote into a directory outside the project through a symlink');
    });
  });

  it('project_index output_path refuses secret and control paths', T, async () => {
    await withNested(async ({ proj }) => {
      await mkdir(path.join(proj, '.git', 'hooks'), { recursive: true });
      for (const output_path of ['.cursorrules', '.env', '.git/hooks/pre-commit']) {
        await callTool(proj, 'mcp_m7_project_index', { ...INDEX, output_path });
      }
      const written = ['.cursorrules', '.env', '.git/hooks/pre-commit'].filter(p => existsSync(path.join(proj, p)));
      assert.deepEqual(written, [], `project_index wrote these control or secret paths:\n${written.join('\n')}`);
    });
  });

  it('project_index still writes the default index and an index inside the project', T, async () => {
    await withNested(async ({ proj }) => {
      await mkdir(path.join(proj, 'docs'));
      const dflt = await callTool(proj, 'mcp_m7_project_index', { ...INDEX });
      assert.ok(existsSync(path.join(proj, 'PROJECT_INDEX.md')), `the default index was not written:\n${dflt.text.slice(0, 500)}`);
      const inner = await callTool(proj, 'mcp_m7_project_index', { ...INDEX, output_path: 'docs/INDEX.md' });
      assert.ok(existsSync(path.join(proj, 'docs/INDEX.md')), `an index inside the project was not written:\n${inner.text.slice(0, 500)}`);
    });
  });
});

// ---------------------------------------------------------------------------
// create_structure
// ---------------------------------------------------------------------------

describe('create_structure containment', () => {
  it('create_structure task id with .. cannot write outside the project', T, async () => {
    await withNested(async ({ outer, proj, outside }) => {
      const res = await callTool(proj, 'mcp_m7_create_structure', {
        task_id: '../../../escaped-task', route: 'medium', description: 'probe',
      });
      assert.deepEqual(
        (await readdir(outer)).sort(),
        ['outside', 'proj'],
        `create_structure created entries outside the project: ${(await readdir(outer)).join(', ')}`,
      );
      assert.deepEqual(await readdir(outside), [], 'create_structure wrote into the outside directory');
      assert.equal(res.isError, true, `the call must fail loudly:\n${res.text.slice(0, 400)}`);
      assert.match(res.text, /outside|refus/i, `the answer must say why:\n${res.text.slice(0, 400)}`);
    });
  });

  it('create_structure does not replace an existing file', T, async () => {
    await withNested(async ({ proj }) => {
      const kept = 'docs/debug/sec-task_probe/SOLUTION_PLAN.md';
      await mkdir(path.join(proj, path.dirname(kept)), { recursive: true });
      await writeFile(path.join(proj, kept), 'USER EDIT\n');
      const res = await callTool(proj, 'mcp_m7_create_structure', { task_id: 'sec-task', route: 'medium', description: 'probe' });
      assert.ok(!res.isError, `create_structure failed:\n${res.text.slice(0, 400)}`);
      assert.equal(await readFile(path.join(proj, kept), 'utf8'), 'USER EDIT\n', `${kept} was replaced`);
      assert.ok(existsSync(path.join(proj, 'docs/debug/sec-task_probe/DISCOVERY_REPORT.md')), 'the other files must still be created');
    });
  });

  it('create_structure does not follow a docs symlink leaving the project', T, async () => {
    // `wx` refuses to replace a file, but it does not protect the parent directories.
    for (const layout of ['docs', 'docs/debug']) {
      await withNested(async ({ proj, outside }) => {
        if (layout === 'docs') {
          await symlink(outside, path.join(proj, 'docs'));
        } else {
          await mkdir(path.join(proj, 'docs'));
          await symlink(outside, path.join(proj, 'docs/debug'));
        }
        const res = await callTool(proj, 'mcp_m7_create_structure', { task_id: 'sec-task', route: 'medium', description: 'probe' });
        assert.deepEqual(await listTree(outside), [], `[${layout} -> outside] create_structure wrote into the outside directory`);
        assert.equal(res.isError, true, `[${layout} -> outside] the call must fail loudly:\n${res.text.slice(0, 400)}`);
      });
    }
  });

  it('analyze_task does not follow a docs symlink leaving the project', T, async () => {
    await withNested(async ({ proj, outside }) => {
      await writeFile(path.join(proj, 'README.md'), 'a user project\n');
      await symlink(outside, path.join(proj, 'docs'));
      await callTool(proj, 'mcp_m7_analyze_task', { task_description: TASK }, { settleMs: 800 });
      assert.deepEqual(await listTree(outside), [], 'analyze_task wrote task files into the outside directory');
    });
  });
});

// ---------------------------------------------------------------------------
// grounding gate
// ---------------------------------------------------------------------------

describe('grounding path premise', () => {
  it('grounding path premise through an outward symlink is not resolved', T, async () => {
    await withNested(async ({ proj, outside }) => {
      await writeFile(path.join(outside, 'secret.txt'), 'outside\n');
      await writeFile(path.join(proj, 'inside.txt'), 'inside\n');
      await symlink(outside, path.join(proj, 'link'));
      await symlink(path.join(outside, 'secret.txt'), path.join(proj, 'leaf.txt'));
      await symlink(path.join(proj, 'inside.txt'), path.join(proj, 'alias.txt'));

      const { resetMemoryCore } = await import(distUrl('memory/auto/unified-memory-core.js'));
      const { resolvePremiseRef } = await import(distUrl('core/orchestrator/groundingGate.js'));
      const restore = await bindProject(proj);
      try {
        resetMemoryCore();
        assert.ok(await resolvePremiseRef('path:inside.txt'), 'control: a file inside the project must resolve');
        assert.ok(await resolvePremiseRef('path:alias.txt'), 'control: a symlink that stays inside the project must resolve');
        assert.equal(await resolvePremiseRef('path:link/secret.txt'), null, 'a path through a directory symlink leaving the project was resolved');
        assert.equal(await resolvePremiseRef('path:leaf.txt'), null, 'a symlink to a file outside the project was resolved');
        assert.equal(await resolvePremiseRef('path:../outside/secret.txt'), null, 'a .. path leaving the project was resolved');
      } finally {
        restore();
        resetMemoryCore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// projectPath helpers
// ---------------------------------------------------------------------------

describe('projectPath', () => {
  it('the prefix-check helpers getProjectRelativePath and resolveProjectPath are gone', async () => {
    const mod = await import(distUrl('core/utils/projectPath.js'));
    assert.equal('getProjectRelativePath' in mod, false, 'getProjectRelativePath is still exported');
    assert.equal('resolveProjectPath' in mod, false, 'resolveProjectPath is still exported');
  });
});

// ---------------------------------------------------------------------------
// pathGuard (support tests: the module is new)
// ---------------------------------------------------------------------------

describe('pathGuard containment rules', () => {
  it('isInside is equal-or-prefix-plus-separator, never a bare prefix', async () => {
    const { isInside, isInsideWith } = await import(distUrl('core/security/pathGuard.js'));
    const cases = [
      ['/a/b', '/a/b', true],
      ['/a/b', '/a/b/c', true],
      ['/a/b', '/a/b/', true],
      ['/a/b', '/a/bc', false],
      ['/a/b', '/a/b-evil/c', false],
      ['/a/b', '/a', false],
      ['/a/b', '/a/c', false],
      ['/a/b', '', false],
      ['', '/a', false],
      ['/', '/x', true],
      ['/', '/', true],
    ];
    for (const [root, target, want] of cases) assert.equal(isInsideWith(root, target, false), want, `${root} contains ${target}`);
    if (process.platform !== 'win32') {
      for (const [root, target, want] of cases) assert.equal(isInside(root, target), want, `isInside ${root} ${target}`);
    }
    // Windows rules: either separator, ASCII case-insensitive.
    assert.equal(isInsideWith('C:\\a\\b', 'c:/A/B/c', true), true);
    assert.equal(isInsideWith('C:\\a\\b', 'C:\\a\\bc', true), false);
    assert.equal(isInsideWith('C:\\a\\b', 'D:\\a\\b', true), false);
    assert.equal(isInsideWith('/a/b', '/A/b', false), false, 'case matters outside Windows');
  });

  it('resolveContained answers the real path inside the root, or null', async () => {
    const { resolveContained } = await import(distUrl('core/security/pathGuard.js'));
    await withNested(async ({ outer, proj, outside }) => {
      await mkdir(path.join(proj, 'sub'));
      await writeFile(path.join(proj, 'file.txt'), 'x');
      await writeFile(path.join(outside, 'o.txt'), 'x');
      await symlink(outside, path.join(proj, 'link-out'));
      await symlink(path.join(outside, 'o.txt'), path.join(proj, 'leaf-out'));
      await symlink(path.join(proj, 'sub'), path.join(proj, 'link-in'));
      await symlink(path.join(outer, 'nowhere'), path.join(proj, 'dangling'));
      const real = await realpath(proj);

      const ok = {
        '': real,
        '.': real,
        'file.txt': path.join(real, 'file.txt'),
        'sub/../file.txt': path.join(real, 'file.txt'),
        'new/deeper/file.txt': path.join(real, 'new/deeper/file.txt'),
        'link-in/x.txt': path.join(real, 'sub/x.txt'),
        [path.join(proj, 'file.txt')]: path.join(real, 'file.txt'),
        [path.join(real, 'file.txt')]: path.join(real, 'file.txt'),
      };
      for (const [rel, want] of Object.entries(ok)) assert.equal(await resolveContained(proj, rel), want, `resolveContained(${JSON.stringify(rel)})`);

      const refused = [
        '..', '../x', '../outside/o.txt', 'sub/../../x',
        'link-out', 'link-out/o.txt', 'link-out/new.txt', 'leaf-out', 'dangling', 'dangling/x',
        'file.txt/child', 'bad\0name', path.join(outside, 'o.txt'), `${proj}-evil/x`, '/etc/passwd',
      ];
      for (const rel of refused) assert.equal(await resolveContained(proj, rel), null, `resolveContained(${JSON.stringify(rel)}) must be refused`);

      assert.equal(await resolveContained(path.join(outer, 'does-not-exist'), 'x'), null, 'a root that cannot be resolved gives null');
    });
  });
});
