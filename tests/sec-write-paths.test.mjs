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
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
// init_project, the cold start, analyze_task and the cycle summary: symlinks
// ---------------------------------------------------------------------------

// `wx` refuses to replace a file, even through a symlink at the final component, but it
// does not protect the parent directories, and a read-then-rewrite follows a link at the
// final component. Each case below plants a symlink in the project that leads outside
// and checks that the outside directory and the outside file stay as they were.

const OUTSIDE_FILE_TEXT = 'OUTSIDE ORIGINAL\n';
const MARKER = '<!-- m7-managed -->';

/** Start a cycle through the tool and return its task id. */
async function startCycleViaTool(server, description) {
  const res = await server.call('mcp_m7_cycle', { task_description: description });
  const m = /task_id="(cycle_[^"]+)"/.exec(res.text);
  assert.ok(m, `no task id in:\n${res.text.slice(0, 400)}`);
  return m[1];
}

describe('init_project does not write through a symlinked directory', () => {
  for (const layout of ['memory-bank', '.cursor', 'docs']) {
    it(`init_project with force does not follow a ${layout} symlink leaving the project`, T, async () => {
      await withNested(async ({ outer, proj, outside }) => {
        await symlink(outside, path.join(proj, layout));
        const res = await callTool(proj, 'mcp_m7_init_project', { force: true });
        assert.deepEqual(await listTree(outside), [], `[${layout} -> outside] init_project wrote into the outside directory`);
        assert.deepEqual((await readdir(outer)).sort(), ['outside', 'proj'], `[${layout} -> outside] init_project created entries next to the project`);
        assert.equal(res.isError, true, `[${layout} -> outside] the call must fail loudly:\n${res.text.slice(0, 400)}`);
        assert.match(res.text, /outside the project/i, `[${layout} -> outside] the answer must say why:\n${res.text.slice(0, 400)}`);
      });
    });
  }
});

describe('.gitignore is never written through a symlink', () => {
  /** The three kinds of link: to an existing outside file, to a missing outside path, to a file inside. */
  const kinds = {
    'a link to an existing file outside the project': async ({ proj, outside }) => {
      await writeFile(path.join(outside, 'zshrc'), OUTSIDE_FILE_TEXT);
      await symlink(path.join(outside, 'zshrc'), path.join(proj, '.gitignore'));
      return { watched: path.join(outside, 'zshrc'), want: OUTSIDE_FILE_TEXT, target: path.join(outside, 'zshrc') };
    },
    'a dangling link to a path outside the project': async ({ proj, outside }) => {
      await symlink(path.join(outside, 'not-yet'), path.join(proj, '.gitignore'));
      return { watched: path.join(outside, 'not-yet'), want: null, target: path.join(outside, 'not-yet') };
    },
  };

  for (const [what, plant] of Object.entries(kinds)) {
    it(`the cold start in an empty directory leaves .gitignore alone when it is ${what}`, T, async () => {
      await withNested(async nested => {
        await rm(path.join(nested.proj, 'package.json')); // an empty project: only the link
        const { watched, want, target } = await plant(nested);
        await callTool(nested.proj, 'mcp_m7_analyze_task', { task_description: TASK }, { settleMs: 800 });

        if (want === null) assert.equal(existsSync(watched), false, 'the cold start created a file outside the project through .gitignore');
        else assert.equal(await readFile(watched, 'utf8'), want, 'the cold start appended to a file outside the project through .gitignore');
        assert.ok((await lstat(path.join(nested.proj, '.gitignore'))).isSymbolicLink(), '.gitignore was replaced by a regular file');
        assert.equal(await readlink(path.join(nested.proj, '.gitignore')), target, '.gitignore now points elsewhere');
        // INDEX.md is written after the project structure step, where .gitignore is handled.
        assert.ok(existsSync(path.join(nested.proj, 'INDEX.md')), 'a link as .gitignore must not stop the rest of the setup');
      });
    });
  }

  it('init_project with force leaves .gitignore alone when it is a link to a file inside the project, and lists it as skipped', T, async () => {
    await withNested(async ({ proj }) => {
      await writeFile(path.join(proj, 'shared-gitignore'), 'node_modules\n');
      await symlink(path.join(proj, 'shared-gitignore'), path.join(proj, '.gitignore'));
      const res = await callTool(proj, 'mcp_m7_init_project', { force: true });
      assert.ok(!res.isError, `init_project failed:\n${res.text.slice(0, 400)}`);
      assert.equal(await readFile(path.join(proj, 'shared-gitignore'), 'utf8'), 'node_modules\n', 'init_project appended to the link target');
      assert.ok((await lstat(path.join(proj, '.gitignore'))).isSymbolicLink(), '.gitignore was replaced by a regular file');
      const heading = /^#{2,3} .*Skipped.*$/m.exec(res.text);
      assert.ok(heading && res.text.slice(heading.index).includes('**.gitignore**'), `.gitignore must be listed as skipped:\n${res.text.slice(0, 800)}`);
    });
  });

  it('init_project still adds .m7/ to a regular .gitignore, once', T, async () => {
    await withNested(async ({ proj }) => {
      await writeFile(path.join(proj, '.gitignore'), 'node_modules\n');
      await callTool(proj, 'mcp_m7_init_project', { force: true });
      await callTool(proj, 'mcp_m7_init_project', { force: true });
      const text = await readFile(path.join(proj, '.gitignore'), 'utf8');
      assert.ok(text.startsWith('node_modules\n'), 'the old lines must stay');
      assert.equal(text.split('.m7/').length - 1, 1, `.m7/ must be there exactly once:\n${text}`);
    });
  });
});

describe('analyze_task does not write activeContext.md through a symlinked memory-bank', () => {
  // Absent outside: the file would be created. Present with the M7 marker: it would count as
  // managed and be rewritten.
  const variants = {
    'no activeContext.md outside': null,
    'a managed activeContext.md outside': `${MARKER}\n# Active Context\n\nOUTSIDE OLD TEXT\n`,
  };
  for (const [what, outsideText] of Object.entries(variants)) {
    it(`a memory-bank link leaving the project with ${what}: nothing is created or rewritten outside`, T, async () => {
      await withNested(async ({ proj, outside }) => {
        await writeFile(path.join(proj, 'README.md'), 'a user project\n');
        await symlink(outside, path.join(proj, 'memory-bank'));
        if (outsideText !== null) await writeFile(path.join(outside, 'activeContext.md'), outsideText);

        await callTool(proj, 'mcp_m7_analyze_task', { task_description: TASK }, { settleMs: 1000 });

        if (outsideText === null) {
          assert.deepEqual(await listTree(outside), [], 'analyze_task created a file outside the project');
        } else {
          assert.deepEqual(await listTree(outside), ['activeContext.md']);
          assert.equal(await readFile(path.join(outside, 'activeContext.md'), 'utf8'), outsideText, 'analyze_task rewrote a file outside the project');
        }
      });
    });
  }

  it('a regular memory-bank with a managed activeContext.md is still updated', T, async () => {
    await withNested(async ({ proj }) => {
      await writeFile(path.join(proj, 'README.md'), 'a user project\n');
      await mkdir(path.join(proj, 'memory-bank'));
      await writeFile(path.join(proj, 'memory-bank/activeContext.md'), `${MARKER}\n# Active Context\n\nOLD TEXT\n`);
      await callTool(proj, 'mcp_m7_analyze_task', { task_description: TASK }, { settleMs: 1000 });
      const after = await readFile(path.join(proj, 'memory-bank/activeContext.md'), 'utf8');
      assert.ok(after.includes(TASK.slice(0, 40)), `the update did not land:\n${after}`);
      assert.ok(!after.includes('OLD TEXT') && after.includes(MARKER));
    });
  });
});

describe('the cycle summary does not write CYCLE_REGISTRY.md through a symlink', () => {
  const kinds = {
    'a link to an existing file outside the project': async ({ proj, outside }) => {
      await writeFile(path.join(outside, 'registry.md'), OUTSIDE_FILE_TEXT);
      await symlink(path.join(outside, 'registry.md'), path.join(proj, 'CYCLE_REGISTRY.md'));
      return { watched: path.join(outside, 'registry.md'), want: OUTSIDE_FILE_TEXT };
    },
    'a dangling link to a path outside the project': async ({ proj, outside }) => {
      await symlink(path.join(outside, 'not-yet.md'), path.join(proj, 'CYCLE_REGISTRY.md'));
      return { watched: path.join(outside, 'not-yet.md'), want: null };
    },
    'a link to a file inside the project': async ({ proj }) => {
      await writeFile(path.join(proj, 'registry-real.md'), OUTSIDE_FILE_TEXT);
      await symlink(path.join(proj, 'registry-real.md'), path.join(proj, 'CYCLE_REGISTRY.md'));
      return { watched: path.join(proj, 'registry-real.md'), want: OUTSIDE_FILE_TEXT };
    },
  };

  for (const [what, plant] of Object.entries(kinds)) {
    it(`mcp_m7_cycle with a summary refuses when CYCLE_REGISTRY.md is ${what}`, T, async () => {
      await withNested(async nested => {
        const s = await startServer(nested.proj);
        try {
          const taskId = await startCycleViaTool(s, 'registry symlink probe');
          const { watched, want } = await plant(nested);
          const res = await s.call('mcp_m7_cycle', { task_id: taskId, summary: 'registry probe summary' });
          await sleep(300);

          if (want === null) assert.equal(existsSync(watched), false, 'the summary created a file through the link');
          else assert.equal(await readFile(watched, 'utf8'), want, 'the summary rewrote the link target');
          assert.ok((await lstat(path.join(nested.proj, 'CYCLE_REGISTRY.md'))).isSymbolicLink(), 'CYCLE_REGISTRY.md was replaced by a regular file');
          assert.equal(res.isError, true, `the call must fail loudly:\n${res.text.slice(0, 400)}`);
          assert.match(res.text, /CYCLE_REGISTRY\.md/, `the answer must name the file:\n${res.text.slice(0, 400)}`);
        } finally {
          await s.stop('close');
        }
      });
    });
  }

  it('mcp_m7_cycle with a summary still writes a regular CYCLE_REGISTRY.md', T, async () => {
    await withNested(async ({ proj }) => {
      const s = await startServer(proj);
      try {
        const taskId = await startCycleViaTool(s, 'registry regular probe');
        const res = await s.call('mcp_m7_cycle', { task_id: taskId, summary: 'registry probe summary' });
        assert.ok(!res.isError, `the summary failed:\n${res.text.slice(0, 400)}`);
        const registry = await readFile(path.join(proj, 'CYCLE_REGISTRY.md'), 'utf8');
        assert.match(registry, /registry probe summary/);
      } finally {
        await s.stop('close');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// memory bridge: appendIfManaged and updateIfManaged
// ---------------------------------------------------------------------------

// The bridge syncs a memory record into one reference file at the project root. The file
// is changed only when it carries the M7 marker, and not when it is a symlink (the open
// uses O_NOFOLLOW). The bridge also resolves the file with resolveContainedEntry, so a
// parent directory that is a link could never lead outside. All three targets sit at
// the project root today, so the only link that can exist is the file itself.

describe('the memory bridge does not write through a symlinked reference file', () => {
  const BRIDGES = [
    {
      name: 'store_at',
      file: 'CYCLE_REGISTRY.md',
      args: { action: 'store_at', level: 'L2', context_keys: ['decision'], content: 'Decision: keep the registry append-only because the audit needs the order.' },
      synced: /Also synced to CYCLE_REGISTRY\.md/,
      landed: text => text.includes('keep the registry append-only'),
    },
    {
      name: 'store_pattern',
      file: 'CODING_STANDARDS.md',
      args: { action: 'store_pattern', pattern: { name: 'retry-with-backoff', description: 'Retry failed calls with backoff', tags: ['retry'] } },
      synced: /Also synced to CODING_STANDARDS\.md/,
      landed: text => text.includes('### retry-with-backoff'),
    },
    {
      name: 'update_project',
      file: 'MASTER_REFERENCE.md',
      args: { action: 'update_project', project: { name: 'bridge-probe', description: 'bridge-probe description' } },
      synced: /Also synced to MASTER_REFERENCE\.md/,
      landed: text => text.includes('bridge-probe description'),
    },
  ];

  for (const b of BRIDGES) {
    it(`memory ${b.name} leaves a file outside the project alone when ${b.file} is a link to it`, T, async () => {
      await withNested(async ({ proj, outside }) => {
        const target = path.join(outside, 'reference.md');
        const original = `${MARKER}\n${OUTSIDE_FILE_TEXT}`;
        await writeFile(target, original);
        await symlink(target, path.join(proj, b.file));

        const res = await callTool(proj, 'mcp_m7_memory', b.args);
        assert.ok(!res.isError, `memory failed:\n${res.text.slice(0, 400)}`);
        assert.equal(await readFile(target, 'utf8'), original, `the bridge wrote through ${b.file} to a file outside the project`);
        assert.ok((await lstat(path.join(proj, b.file))).isSymbolicLink(), `${b.file} was replaced by a regular file`);
        assert.match(res.text, /not synced/i, 'the answer must say the entry was not synced');
        assert.ok(!b.synced.test(res.text), 'the answer claims a sync that did not happen');
      });
    });

    it(`memory ${b.name} creates nothing outside the project when ${b.file} is a dangling link`, T, async () => {
      await withNested(async ({ proj, outside }) => {
        const target = path.join(outside, 'not-yet.md');
        await symlink(target, path.join(proj, b.file));

        const res = await callTool(proj, 'mcp_m7_memory', b.args);
        assert.ok(!res.isError, `memory failed:\n${res.text.slice(0, 400)}`);
        assert.equal(existsSync(target), false, 'the bridge created a file outside the project through the link');
        assert.match(res.text, /not synced/i);
      });
    });

    it(`memory ${b.name} still syncs a managed ${b.file} when the project path itself is a symlink`, T, async () => {
      await withNested(async ({ outer, proj }) => {
        await writeFile(path.join(proj, b.file), `${MARKER}\n# Reference\n`);
        const viaLink = path.join(outer, 'proj-link');
        await symlink(proj, viaLink);

        const res = await callTool(viaLink, 'mcp_m7_memory', b.args);
        assert.ok(!res.isError, `memory failed:\n${res.text.slice(0, 400)}`);
        assert.match(res.text, b.synced, `no sync reported:\n${res.text.slice(0, 600)}`);
        assert.ok(b.landed(await readFile(path.join(proj, b.file), 'utf8')), 'the entry did not land in the real project');
      });
    });
  }
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

  it('resolveContainedEntry contains the parent directory and does not follow the last component', async () => {
    const { resolveContainedEntry } = await import(distUrl('core/security/pathGuard.js'));
    await withNested(async ({ outer, proj, outside }) => {
      await mkdir(path.join(proj, 'sub'));
      await writeFile(path.join(outside, 'o.txt'), 'x');
      await symlink(outside, path.join(proj, 'link-out'));
      await symlink(path.join(outside, 'o.txt'), path.join(proj, 'leaf-out'));
      await symlink(path.join(outer, 'nowhere'), path.join(proj, 'dangling'));
      const real = await realpath(proj);

      const ok = {
        'file.txt': path.join(real, 'file.txt'),
        'sub/file.txt': path.join(real, 'sub/file.txt'),
        'new/deeper/file.txt': path.join(real, 'new/deeper/file.txt'),
        // The last component is not followed: a link stays a link in the answer.
        'leaf-out': path.join(real, 'leaf-out'),
        dangling: path.join(real, 'dangling'),
        [path.join(proj, 'sub/file.txt')]: path.join(real, 'sub/file.txt'),
      };
      for (const [rel, want] of Object.entries(ok)) assert.equal(await resolveContainedEntry(proj, rel), want, `resolveContainedEntry(${JSON.stringify(rel)})`);

      const refused = [
        '', '.', '..', 'sub/..', 'sub/.', '../x', 'sub/../../x', 'link-out/x.txt', 'link-out/new/x.txt',
        'bad\0name', 'sub/bad\0name', path.join(outside, 'o.txt'), `${proj}-evil/x`, '/etc/passwd',
      ];
      for (const rel of refused) assert.equal(await resolveContainedEntry(proj, rel), null, `resolveContainedEntry(${JSON.stringify(rel)}) must be refused`);
    });
  });
});

// ---------------------------------------------------------------------------
// SEC-26: M7 data folders that lead outside the project
// ---------------------------------------------------------------------------

// A cloned repo can ship `.m7`, `.m7/memory`, `m7-cycles` or `knowledge-hub` as a symlink.
// Memory, journal, cycle and hub files then land in the folder the link names. The server
// checks these folders before a tool runs, and again when a tool names a project_path.
// Each case plants the link, seeds the outside folder, makes one call, and compares the
// outside folder byte for byte. The refusal text is the second assertion of each test.

const REFUSED = /Refusing to write outside the project/;

/** Every entry under `root` mapped to its bytes (directories to '', symlinks to their target); links are not followed. */
async function snapshotBytes(root) {
  const out = {};
  async function walk(rel) {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(root, r);
      if (e.isSymbolicLink()) out[r] = `-> ${await readlink(full)}`;
      else if (e.isDirectory()) {
        out[`${r}/`] = '';
        await walk(r);
      } else out[r] = (await readFile(full)).toString('base64');
    }
  }
  await walk('');
  return out;
}

/** The outside folder holds what an older M7 run left there: a features file the journal would append to. */
async function seedOutside(outside) {
  await writeFile(path.join(outside, 'features.json'), '[]\n');
  await writeFile(path.join(outside, 'errors.json'), '[]\n');
}

const DATA_LINKS = {
  '.m7': async ({ proj, outside }) => {
    await symlink(outside, path.join(proj, '.m7'));
  },
  '.m7/memory': async ({ proj, outside }) => {
    await mkdir(path.join(proj, '.m7'));
    await symlink(outside, path.join(proj, '.m7', 'memory'));
  },
  'm7-cycles': async ({ proj, outside }) => {
    await symlink(outside, path.join(proj, 'm7-cycles'));
  },
};

/** One tool call on a project whose data folder is a link. The outside folder must stay as seeded. */
async function callWithPlantedLink(layout, tool, args) {
  await withNested(async nested => {
    await seedOutside(nested.outside);
    await DATA_LINKS[layout](nested);
    const before = await snapshotBytes(nested.outside);
    const res = await callTool(nested.proj, tool, args, { settleMs: 700 });
    const after = await snapshotBytes(nested.outside);
    assert.deepEqual(after, before, `[${layout} -> outside] ${tool} changed the folder outside the project`);
    assert.equal(res.isError, true, `[${layout} -> outside] ${tool} must be refused:\n${res.text.slice(0, 400)}`);
    assert.match(res.text, REFUSED, `[${layout} -> outside] the answer must say why:\n${res.text.slice(0, 400)}`);
  });
}

describe('SEC-26: a .m7 folder that leads outside the project', () => {
  const calls = {
    analyze_task: ['mcp_m7_analyze_task', { task_description: TASK }],
    // store_at L2 is a level M7 writes to .m7/memory; plain `store` keeps its record in memory only.
    'memory store': ['mcp_m7_memory', { action: 'store_at', level: 'L2', content: 'Decision: sec-26 probe record, written to the durable level.', context_keys: ['sec-26'] }],
    check_errors: ['mcp_m7_check_errors', {}],
  };
  for (const layout of ['.m7', '.m7/memory']) {
    for (const [name, [tool, args]] of Object.entries(calls)) {
      it(`${name} leaves the outside folder byte-identical when ${layout} is a link to it`, T, () => callWithPlantedLink(layout, tool, args));
    }
  }
});

describe('SEC-26: an m7-cycles folder that leads outside the project', () => {
  it('a cycle start leaves the outside folder byte-identical when m7-cycles is a link to it', T, () =>
    callWithPlantedLink('m7-cycles', 'mcp_m7_cycle', { task_description: 'sec-26 cycle probe' }));
});

describe('SEC-26: a project_path that names a project with a link', () => {
  it('init_project with an explicit project_path is refused when the project .m7 leads outside', T, async () => {
    await withNested(async ({ outer, proj, outside }) => {
      const clean = path.join(outer, 'clean');
      await mkdir(clean);
      await writeFile(path.join(clean, 'package.json'), JSON.stringify({ name: 'clean-fixture' }));
      await seedOutside(outside);
      await symlink(outside, path.join(proj, '.m7'));
      const before = await snapshotBytes(outside);

      const res = await callTool(clean, 'mcp_m7_init_project', { project_path: proj, force: true }, { settleMs: 700 });
      assert.deepEqual(await snapshotBytes(outside), before, 'init_project changed the folder outside the project');
      assert.equal(res.isError, true, `init_project must be refused:\n${res.text.slice(0, 400)}`);
      assert.match(res.text, REFUSED, `the answer must say why:\n${res.text.slice(0, 400)}`);
    });
  });

  it('project_index with an explicit project_path leaves the outside folder alone when the project .m7 leads outside', T, async () => {
    await withNested(async ({ outer, proj, outside }) => {
      const clean = path.join(outer, 'clean');
      await mkdir(clean);
      await writeFile(path.join(clean, 'package.json'), JSON.stringify({ name: 'clean-fixture' }));
      await writeFile(path.join(proj, 'PROJECT_INDEX.md'), '# old index\n');
      await seedOutside(outside);
      await symlink(outside, path.join(proj, '.m7'));
      const before = await snapshotBytes(outside);

      const res = await callTool(clean, 'mcp_m7_project_index', { action: 'update', project_path: proj, force: true }, { settleMs: 700 });
      assert.deepEqual(await snapshotBytes(outside), before, 'project_index wrote its cache into the folder outside the project');
      assert.match(res.text, /"success": false/, `project_index must report the refusal:\n${res.text.slice(0, 400)}`);
      assert.match(res.text, REFUSED, `the answer must say why:\n${res.text.slice(0, 400)}`);
    });
  });
});

describe('SEC-26: a knowledge-hub folder that leads outside the project', () => {
  it('knowledge_hub init leaves the outside folder alone when knowledge-hub is a link to it', T, async () => {
    await withNested(async ({ proj, outside }) => {
      await symlink(outside, path.join(proj, 'knowledge-hub'));
      const res = await callTool(proj, 'mcp_m7_knowledge_hub', { action: 'init' }, { settleMs: 700 });
      assert.deepEqual(await listTree(outside), [], 'knowledge_hub init wrote the hub into the folder outside the project');
      assert.match(res.text, /"success": false/, `init must report the refusal:\n${res.text.slice(0, 400)}`);
      assert.match(res.text, REFUSED, `the answer must say why:\n${res.text.slice(0, 400)}`);
    });
  });
});

describe('SEC-26: what must keep working', () => {
  it('a server that starts and exits without a tool call leaves the outside folder untouched (guard: may pass on old code)', T, async () => {
    await withNested(async ({ proj, outside }) => {
      await seedOutside(outside);
      await symlink(outside, path.join(proj, '.m7'));
      await symlink(outside, path.join(proj, 'm7-cycles'));
      const before = await snapshotBytes(outside);
      const s = await startServer(proj);
      try {
        await sleep(800);
      } finally {
        await s.stop('close');
      }
      assert.deepEqual(await snapshotBytes(outside), before, 'the server wrote into the folder outside the project without any tool call');
    });
  });

  it('control: .m7 as a link to a folder inside the project still works', T, async () => {
    await withNested(async ({ proj }) => {
      await mkdir(path.join(proj, 'data'));
      await symlink(path.join(proj, 'data'), path.join(proj, '.m7'));
      const res = await callTool(proj, 'mcp_m7_analyze_task', { task_description: TASK }, { settleMs: 700 });
      assert.ok(!res.isError, `analyze_task must work:\n${res.text.slice(0, 400)}`);
      assert.ok((await readdir(path.join(proj, 'data'))).length > 0, 'M7 wrote nothing into the folder the link names');
      assert.ok((await lstat(path.join(proj, '.m7'))).isSymbolicLink(), '.m7 was replaced by a real folder');
    });
  });
});

// ---------------------------------------------------------------------------
// dataDirRefusal (support tests: the function is new)
// ---------------------------------------------------------------------------

describe('SEC-26: dataDirRefusal and linkLeavesRoot', () => {
  it('linkLeavesRoot: a dangling link or a target outside the root leaves it', async () => {
    const { linkLeavesRoot } = await import(distUrl('core/security/pathGuard.js'));
    assert.equal(linkLeavesRoot('/p', null), true, 'a dangling link leaves');
    assert.equal(linkLeavesRoot('/p', '/q/x'), true);
    assert.equal(linkLeavesRoot('/p', '/p-evil/x'), true, 'a bare prefix is not inside');
    assert.equal(linkLeavesRoot('/p', '/p'), false);
    assert.equal(linkLeavesRoot('/p', '/p/a/b'), false);
  });

  it('dataDirRefusal: folders that are absent, plain, or linked inside the project pass', async () => {
    const { dataDirRefusal } = await import(distUrl('core/security/pathGuard.js'));
    await withNested(async ({ proj, outside }) => {
      assert.equal(dataDirRefusal(proj, ['.m7', 'm7-cycles']), null, 'absent folders pass');
      await mkdir(path.join(proj, '.m7', 'memory'), { recursive: true });
      await writeFile(path.join(proj, '.m7', 'memory', 'a.json'), '{}');
      await mkdir(path.join(proj, 'data'));
      await symlink(path.join(proj, 'data'), path.join(proj, 'm7-cycles'));
      await symlink(path.join(proj, 'data'), path.join(proj, '.m7', 'inner-link'));
      await symlink(path.join(proj, 'package.json'), path.join(proj, '.m7', 'file-link'));
      assert.equal(dataDirRefusal(proj, ['.m7', 'm7-cycles']), null, 'links that stay inside the project pass');
      assert.equal(dataDirRefusal(proj, []), null, 'no folder to check');
      assert.deepEqual(await readdir(outside), []);
    });
  });

  it('dataDirRefusal: a folder or a nested link that leaves the project, or dangles, is refused with its path', async () => {
    const { dataDirRefusal } = await import(distUrl('core/security/pathGuard.js'));
    const cases = {
      'the folder is a link outside': async ({ proj, outside }) => symlink(outside, path.join(proj, '.m7')),
      'a nested link outside': async ({ proj, outside }) => {
        await mkdir(path.join(proj, '.m7', 'a', 'b'), { recursive: true });
        await symlink(outside, path.join(proj, '.m7', 'a', 'b', 'deep'));
      },
      'a nested link to a file outside': async ({ proj, outside }) => {
        await writeFile(path.join(outside, 'f.txt'), 'x');
        await mkdir(path.join(proj, '.m7'));
        await symlink(path.join(outside, 'f.txt'), path.join(proj, '.m7', 'features.json'));
      },
      'a dangling link': async ({ proj, outer }) => {
        await mkdir(path.join(proj, '.m7'));
        await symlink(path.join(outer, 'nowhere'), path.join(proj, '.m7', 'gone'));
      },
      'a dangling link as the folder': async ({ proj, outer }) => symlink(path.join(outer, 'nowhere'), path.join(proj, '.m7')),
    };
    for (const [what, plant] of Object.entries(cases)) {
      await withNested(async nested => {
        await plant(nested);
        const refusal = dataDirRefusal(nested.proj, ['.m7']);
        assert.ok(typeof refusal === 'string' && /Refusing to write outside the project: /.test(refusal), `[${what}] expected a refusal, got ${JSON.stringify(refusal)}`);
        assert.ok(refusal.includes('.m7'), `[${what}] the refusal must name the path: ${refusal}`);
      });
    }
  });

  it('dataDirRefusal: more than 20000 entries are refused, 20000 are not', async () => {
    const { dataDirRefusal, DATA_DIR_MAX_ENTRIES } = await import(distUrl('core/security/pathGuard.js'));
    assert.equal(DATA_DIR_MAX_ENTRIES, 20000);
    await withNested(async ({ proj }) => {
      const dir = path.join(proj, '.m7');
      await mkdir(dir);
      await Promise.all(Array.from({ length: 20000 }, (_, i) => writeFile(path.join(dir, `f${i}`), '')));
      assert.equal(dataDirRefusal(proj, ['.m7']), null, 'exactly 20000 entries pass');
      await writeFile(path.join(dir, 'one-more'), '');
      const refusal = dataDirRefusal(proj, ['.m7']);
      assert.ok(typeof refusal === 'string' && /20000/.test(refusal), `20001 entries must be refused, got ${JSON.stringify(refusal)}`);
    });
  });

  it('dataDirRefusal: a root that cannot be resolved is refused', async () => {
    const { dataDirRefusal } = await import(distUrl('core/security/pathGuard.js'));
    await withNested(async ({ outer }) => {
      assert.equal(typeof dataDirRefusal(path.join(outer, 'does-not-exist'), ['.m7']), 'string');
    });
  });
});
