/**
 * SEC-19 and SEC-20 (MEDIUM): the knowledge hub never moves or replaces a project
 * file on its own, and a document path stays inside the hub.
 *
 * Four rules are tested:
 * - `init` does not move the root documents (INDEX.md and similar) into the hub;
 * - `migrate` keeps a file that is already in the hub, and says so;
 * - a document path (from `hub-config.yaml`, or a hub folder that is a symlink)
 *   that leaves the hub or the project writes nothing;
 * - SEC-31: a document that is a symlink is never read or replaced, a planted
 *   `<document>.tmp` link is never written through, and a document id or a version
 *   name cannot leave the versions folder.
 *
 * Every server test starts the real MCP server (`node dist/index.js`) over stdio on a
 * throwaway project. The project sits one level down in a throwaway outer directory
 * (`<outer>/proj`, with `<outer>/outside` next to it), so a write that escapes the
 * project lands in the outer directory and not in the system temp directory.
 *
 * The pure-rule tests import functions added by this fix inside the test, so a
 * missing function fails only that test and never hides the server tests.
 *
 * Limit, stated on purpose: a path is checked, then used. A symlink swapped between
 * the check and the write is not caught.
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-knowledge-hub.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DIST, startServer } from './helpers/deepScanHarness.mjs';

const T = { timeout: 90_000 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const distUrl = rel => new URL(`file://${path.join(DIST, rel)}`).href;

const ROOT_DOCS = ['INDEX.md', 'FIELD_DICTIONARY.md', 'PROJECT_STRUCTURE.md', 'API_REFERENCE.md', 'TECH_STACK.md'];
const userText = name => `USER CONTENT of ${name}. Owned by the user, not by the hub.\n`;

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
  await writeFile(path.join(proj, 'package.json'), JSON.stringify({ name: 'knowledge-hub-fixture' }));
  return { outer, proj, outside };
}

async function withNested(fn) {
  const n = await makeNested('sec-hub-');
  try {
    return await fn(n);
  } finally {
    await rm(n.outer, { recursive: true, force: true });
  }
}

/**
 * Start the server on `proj` and give `fn` a `call(args)` for `mcp_m7_knowledge_hub`.
 * The server is stopped after `fn`, and late writes get a moment to land.
 */
async function withHub(proj, fn) {
  const s = await startServer(proj);
  try {
    const call = args => s.call('mcp_m7_knowledge_hub', args);
    const out = await fn(call);
    await sleep(300);
    return out;
  } finally {
    await s.stop('close');
  }
}

/** The tool answers with JSON text. Returns the object, or null when it is not JSON. */
function body(res) {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

async function seedRootDocs(proj, names = ROOT_DOCS) {
  for (const name of names) await writeFile(path.join(proj, name), userText(name));
}

const hubFile = (proj, rel) => path.join(proj, 'knowledge-hub', rel);

async function entriesOf(dir) {
  return (await readdir(dir)).sort();
}

/** The text of a file, or null when it is missing: a moved file then fails an assertion, not a read. */
async function textOrNull(file) {
  return readFile(file, 'utf8').catch(() => null);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe('knowledge_hub init', () => {
  it('init leaves INDEX.md and the other root documents where they are', T, async () => {
    await withNested(async ({ proj }) => {
      await seedRootDocs(proj);
      const res = await withHub(proj, call => call({ action: 'init' }));

      for (const name of ROOT_DOCS) {
        assert.equal(await textOrNull(path.join(proj, name)), userText(name), `init moved or changed ${name} in the project root`);
      }
      const hubIndex = (await textOrNull(hubFile(proj, 'core/INDEX.md'))) ?? '';
      assert.ok(!hubIndex.includes('USER CONTENT'), 'the hub INDEX.md holds the root file; init must not move it');
      const out = body(res);
      assert.ok(out, `init answer is not JSON:\n${res.text.slice(0, 400)}`);
      assert.ok(!out.documents_migrated, `init reports ${out.documents_migrated} migrated documents`);
    });
  });

  it('init without root documents still creates the hub documents', T, async () => {
    await withNested(async ({ proj }) => {
      const res = await withHub(proj, call => call({ action: 'init' }));
      assert.equal(body(res)?.success, true, `init failed:\n${res.text.slice(0, 400)}`);
      for (const rel of ['core/INDEX.md', 'core/FIELD_DICTIONARY.md', 'core/PROJECT_STRUCTURE.md', 'config/hub-config.yaml']) {
        assert.ok(existsSync(hubFile(proj, rel)), `${rel} was not created`);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

describe('knowledge_hub migrate', () => {
  it('migrate moves a root document to a free place in the hub', T, async () => {
    await withNested(async ({ proj }) => {
      await withHub(proj, async call => {
        await call({ action: 'init' });
        await seedRootDocs(proj, ['API_REFERENCE.md']);
        const res = await call({ action: 'migrate' });
        assert.equal(body(res)?.migrated_count, 1, `migrate answer:\n${res.text.slice(0, 600)}`);
      });
      assert.ok(!existsSync(path.join(proj, 'API_REFERENCE.md')), 'the root file was not moved');
      assert.equal(await textOrNull(hubFile(proj, 'api/API_REFERENCE.md')), userText('API_REFERENCE.md'));
    });
  });

  it('migrate keeps a file that is already in the hub, leaves the root file, and reports it', T, async () => {
    await withNested(async ({ proj }) => {
      let res;
      let before;
      await withHub(proj, async call => {
        await call({ action: 'init' });
        before = await readFile(hubFile(proj, 'core/INDEX.md'));
        await seedRootDocs(proj, ['INDEX.md']);
        res = await call({ action: 'migrate' });
      });

      assert.deepEqual(await readFile(hubFile(proj, 'core/INDEX.md')), before, 'migrate replaced the INDEX.md that was already in the hub');
      assert.equal(await textOrNull(path.join(proj, 'INDEX.md')), userText('INDEX.md'), 'migrate moved or changed the root INDEX.md');

      const out = body(res);
      assert.ok(out, `migrate answer is not JSON:\n${res.text.slice(0, 400)}`);
      assert.equal(out.migrated_count, 0);
      assert.equal(out.skipped_files?.length, 1, `the answer must list the kept file:\n${res.text.slice(0, 600)}`);
      assert.match(out.skipped_files[0].original_path, /INDEX\.md$/);
      assert.match(res.text, /kept/i, 'the message must say the existing hub file was kept');
    });
  });

  it('migrate with every target taken moves nothing and still succeeds', T, async () => {
    await withNested(async ({ proj }) => {
      const core = ['INDEX.md', 'FIELD_DICTIONARY.md', 'PROJECT_STRUCTURE.md'];
      const before = new Map();
      let res;
      await withHub(proj, async call => {
        await call({ action: 'init' });
        for (const name of core) before.set(name, await readFile(hubFile(proj, `core/${name}`)));
        await seedRootDocs(proj, core);
        res = await call({ action: 'migrate' });
      });

      for (const name of core) {
        assert.deepEqual(await readFile(hubFile(proj, `core/${name}`)), before.get(name), `migrate replaced core/${name} in the hub`);
        assert.equal(await textOrNull(path.join(proj, name)), userText(name), `migrate moved or changed the root ${name}`);
      }
      const out = body(res);
      assert.equal(out?.success, true, `keeping files is not a failure:\n${res.text.slice(0, 600)}`);
      assert.equal(out.migrated_count, 0);
      assert.equal(out.skipped_files?.length, 3);
    });
  });

  it('migrate moves what has a free place and keeps what has not', T, async () => {
    await withNested(async ({ proj }) => {
      let res;
      await withHub(proj, async call => {
        await call({ action: 'init' });
        await seedRootDocs(proj, ['INDEX.md', 'API_REFERENCE.md', 'TECH_STACK.md']);
        res = await call({ action: 'migrate' });
      });

      assert.equal(await textOrNull(path.join(proj, 'INDEX.md')), userText('INDEX.md'), 'the root INDEX.md must stay');
      assert.ok(!(await textOrNull(hubFile(proj, 'core/INDEX.md')) ?? '').includes('USER CONTENT'), 'the hub INDEX.md was replaced');
      assert.equal(await textOrNull(hubFile(proj, 'api/API_REFERENCE.md')), userText('API_REFERENCE.md'), 'API_REFERENCE.md was not moved into the hub');
      assert.equal(await textOrNull(hubFile(proj, 'tech/TECH_STACK.md')), userText('TECH_STACK.md'), 'TECH_STACK.md was not moved into the hub');
      const out = body(res);
      assert.equal(out?.migrated_count, 2, `migrate answer:\n${res.text.slice(0, 600)}`);
      assert.equal(out.skipped_files?.length, 1);
    });
  });

  it('migrate refuses a hub folder that is a symlink leaving the project', T, async () => {
    await withNested(async ({ proj, outside }) => {
      await mkdir(path.join(proj, 'knowledge-hub'));
      await symlink(outside, hubFile(proj, 'core'));
      await seedRootDocs(proj, ['INDEX.md']);
      const res = await withHub(proj, call => call({ action: 'migrate' }));

      assert.deepEqual(await entriesOf(outside), [], 'migrate moved a root document into a directory outside the project');
      assert.equal(await textOrNull(path.join(proj, 'INDEX.md')), userText('INDEX.md'), 'the root INDEX.md is gone');
      assert.match(res.text, /"success": false/, `migrate must report the refusal:\n${res.text.slice(0, 600)}`);
    });
  });
});

// ---------------------------------------------------------------------------
// document paths
// ---------------------------------------------------------------------------

/** Replace the path of the INDEX document in hub-config.yaml. */
async function setIndexPath(proj, newPath) {
  const file = hubFile(proj, 'config/hub-config.yaml');
  const text = await readFile(file, 'utf8');
  assert.ok(text.includes('path: core/INDEX.md'), `unexpected hub-config.yaml:\n${text.slice(0, 500)}`);
  await writeFile(file, text.replace('path: core/INDEX.md', `path: ${newPath}`));
}

describe('knowledge_hub document paths', () => {
  it('update refuses a document path that leaves the project', T, async () => {
    await withNested(async ({ outer, proj, outside }) => {
      const res = await withHub(proj, async call => {
        await call({ action: 'init' });
        await setIndexPath(proj, '../../outside/pwned.md');
        return call({ action: 'update', document_id: 'INDEX', require_confirmation: false });
      });
      assert.deepEqual(await entriesOf(outside), [], 'update wrote a document outside the project');
      assert.ok(!existsSync(path.join(outer, 'pwned.md')));
      assert.match(res.text, /"success": false/, `update must report the refusal:\n${res.text.slice(0, 600)}`);
    });
  });

  it('update refuses a document path that leaves the hub but stays in the project', T, async () => {
    await withNested(async ({ proj }) => {
      const res = await withHub(proj, async call => {
        await call({ action: 'init' });
        await setIndexPath(proj, '../README.md');
        return call({ action: 'update', document_id: 'INDEX', require_confirmation: false });
      });
      assert.ok(!existsSync(path.join(proj, 'README.md')), 'update wrote README.md next to the hub');
      assert.match(res.text, /"success": false/, `update must report the refusal:\n${res.text.slice(0, 600)}`);
    });
  });

  it('sync refuses a document path that leaves the project', T, async () => {
    await withNested(async ({ proj, outside }) => {
      await withHub(proj, async call => {
        await call({ action: 'init' });
        await setIndexPath(proj, '../../outside/synced.md');
        await call({ action: 'sync', require_confirmation: false });
      });
      assert.deepEqual(await entriesOf(outside), [], 'sync wrote a document outside the project');
    });
  });

  it('init refuses a hub folder that is a symlink leaving the project', T, async () => {
    await withNested(async ({ proj, outside }) => {
      await mkdir(path.join(proj, 'knowledge-hub'));
      await symlink(outside, hubFile(proj, 'core'));
      await withHub(proj, call => call({ action: 'init' }));
      assert.deepEqual(await entriesOf(outside), [], 'init wrote hub documents into a directory outside the project');
    });
  });

  it('status and update still work for documents inside the hub', T, async () => {
    await withNested(async ({ proj }) => {
      await withHub(proj, async call => {
        await call({ action: 'init' });
        const status = await call({ action: 'status' });
        const out = body(status);
        assert.equal(out?.initialized, true, `status:\n${status.text.slice(0, 400)}`);
        assert.ok(out.documents.every(d => d.exists), 'every default document must exist after init');

        await writeFile(path.join(proj, 'notes.ts'), 'export const x = 1;\n');
        const upd = await call({ action: 'update', document_id: 'INDEX', require_confirmation: false });
        assert.equal(body(upd)?.success, true, `update failed:\n${upd.text.slice(0, 400)}`);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// pure rules
// ---------------------------------------------------------------------------

describe('knowledge_hub: pure rules', () => {
  it('migrationAction keeps a target that exists and moves to one that is free', async () => {
    const { migrationAction } = await import(distUrl('core/tools/knowledgeHub/core/MigrationManager.js'));
    assert.equal(migrationAction(false), 'move');
    assert.equal(migrationAction(true), 'keep');
  });

  it('hubDocumentPath returns a path strictly inside the hub, otherwise null', async () => {
    const { hubDocumentPath } = await import(distUrl('core/tools/knowledgeHub/utils/configUtils.js'));
    const hub = '/p/knowledge-hub';
    assert.equal(hubDocumentPath('/p', 'core/INDEX.md'), `${hub}/core/INDEX.md`);
    assert.equal(hubDocumentPath('/p', 'core/../INDEX.md'), `${hub}/INDEX.md`);
    // An absolute-looking path is joined below the hub, as before.
    assert.equal(hubDocumentPath('/p', '/etc/x.md'), `${hub}/etc/x.md`);
    for (const bad of ['../x.md', 'core/../../x.md', '../../outside/x.md', '', '.', '..', 'a\0b.md']) {
      assert.equal(hubDocumentPath('/p', bad), null, `${JSON.stringify(bad)} must be refused`);
    }
    // A sibling whose name starts with the hub name is not inside the hub.
    assert.equal(hubDocumentPath('/p', '../knowledge-hub-evil/x.md'), null);
  });
});

// ---------------------------------------------------------------------------
// SEC-31: document links, temporary files, document ids and version names
// ---------------------------------------------------------------------------

// The C1 check (SEC-26) walks the `knowledge-hub` folder before every action and refuses a
// link that leaves the project. The tests below therefore use what that walk lets through:
// a link to a file inside the project, and functions called directly.

const SECRET = 'SEC31-SECRET-CANARY';
const OUTSIDE_CANARY = 'SEC31-OUTSIDE-CANARY';

/** Text of every regular file under `dir`, keyed by relative path (links are not followed). */
async function textsUnder(dir) {
  const out = {};
  async function walk(rel) {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) out[r] = await readFile(path.join(dir, r), 'utf8');
    }
  }
  await walk('');
  return out;
}

/** A version file as VersionManager writes it. `version` may differ from the file name. */
const versionYaml = ({ version, change = 'planted' }) => [
  `version: ${version}`,
  'document_id: INDEX',
  'content: old content',
  'metadata:',
  '  changes:',
  `    - ${change}`,
  '  trigger: manual',
  '  author: planted',
  'created_at: 2020-01-01T00:00:00.000Z',
  '',
].join('\n');

describe('SEC-31: a document that is a symlink', () => {
  it('update does not copy the text of a document link into versions/ or the answer', T, async () => {
    await withNested(async ({ proj }) => {
      await writeFile(path.join(proj, '.env'), `${SECRET}\n`);
      let res;
      await withHub(proj, async call => {
        await call({ action: 'init' });
        await rm(hubFile(proj, 'core/INDEX.md'));
        await symlink('../../.env', hubFile(proj, 'core/INDEX.md'));
        res = await call({ action: 'update', document_id: 'INDEX', require_confirmation: false });
      });

      const texts = await textsUnder(path.join(proj, 'knowledge-hub'));
      const leaked = Object.entries(texts).filter(([, text]) => text.includes(SECRET)).map(([name]) => name);
      assert.deepEqual(leaked, [], `the text of the linked file was copied into the hub: ${leaked.join(', ')}`);
      assert.ok(!res.text.includes(SECRET), 'the answer holds the text of the linked file');
      assert.equal(await readFile(path.join(proj, '.env'), 'utf8'), `${SECRET}\n`, 'the linked file changed');
      assert.match(res.text, /"success": false/, `update must report the refusal:\n${res.text.slice(0, 600)}`);
    });
  });

  it('DocumentManager.load refuses a document that is a link to a file outside the project', T, async () => {
    const { DocumentManager } = await import(distUrl('core/tools/knowledgeHub/core/DocumentManager.js'));
    await withNested(async ({ proj, outside }) => {
      await mkdir(path.join(proj, 'knowledge-hub', 'core'), { recursive: true });
      await writeFile(path.join(outside, 'credentials'), `${SECRET}\n`);
      await symlink(path.join(outside, 'credentials'), hubFile(proj, 'core/INDEX.md'));
      const manager = new DocumentManager(proj);

      let loaded = null;
      let error = null;
      try {
        loaded = await manager.load('core/INDEX.md');
      } catch (e) {
        error = e;
      }
      assert.equal(loaded?.content?.includes(SECRET) ?? false, false, 'load returned the text of a file outside the project');
      assert.equal(error?.code, 'INVALID_PATH', `load must fail with INVALID_PATH, got ${error?.code ?? 'no error'}`);
    });
  });

  it('DocumentManager.save refuses a document that is a link, and the link stays', T, async () => {
    const { DocumentManager } = await import(distUrl('core/tools/knowledgeHub/core/DocumentManager.js'));
    await withNested(async ({ proj, outside }) => {
      await mkdir(path.join(proj, 'knowledge-hub', 'core'), { recursive: true });
      await writeFile(path.join(outside, 'target.md'), 'OUTSIDE ORIGINAL\n');
      await symlink(path.join(outside, 'target.md'), hubFile(proj, 'core/INDEX.md'));
      const manager = new DocumentManager(proj);

      let error = null;
      try {
        await manager.save('core/INDEX.md', 'new text');
      } catch (e) {
        error = e;
      }
      assert.ok((await lstat(hubFile(proj, 'core/INDEX.md'))).isSymbolicLink(), 'save replaced the link with a regular file');
      assert.equal(await readFile(path.join(outside, 'target.md'), 'utf8'), 'OUTSIDE ORIGINAL\n', 'save changed the link target');
      assert.ok(error, 'save must fail when the document is a link');
    });
  });

  it('DocumentManager still loads, saves and finds a regular document', T, async () => {
    const { DocumentManager } = await import(distUrl('core/tools/knowledgeHub/core/DocumentManager.js'));
    await withNested(async ({ proj }) => {
      const manager = new DocumentManager(proj);
      assert.equal(await manager.exists('core/INDEX.md'), false);
      await manager.save('core/INDEX.md', 'hello hub');
      assert.equal(await manager.exists('core/INDEX.md'), true);
      assert.equal((await manager.load('core/INDEX.md')).content, 'hello hub');
    });
  });
});

describe('SEC-31: the temporary file of safeWriteFile', () => {
  const kinds = {
    'a link to an existing file': async ({ outside }) => {
      await writeFile(path.join(outside, 'target.txt'), 'OUTSIDE ORIGINAL\n');
      return { target: path.join(outside, 'target.txt'), want: 'OUTSIDE ORIGINAL\n' };
    },
    'a dangling link': async ({ outside }) => ({ target: path.join(outside, 'not-yet.txt'), want: null }),
  };

  for (const [what, plant] of Object.entries(kinds)) {
    it(`a planted <document>.tmp that is ${what} is not written through`, T, async () => {
      const { safeWriteFile } = await import(distUrl('core/tools/knowledgeHub/utils/fileUtils.js'));
      await withNested(async nested => {
        const dir = path.join(nested.proj, 'knowledge-hub', 'core');
        await mkdir(dir, { recursive: true });
        const { target, want } = await plant(nested);
        await symlink(target, path.join(dir, 'INDEX.md.tmp'));

        await safeWriteFile(path.join(dir, 'INDEX.md'), 'NEW CONTENT\n');

        if (want === null) assert.equal(existsSync(target), false, 'safeWriteFile created a file outside the project through the .tmp link');
        else assert.equal(await readFile(target, 'utf8'), want, 'safeWriteFile wrote through the .tmp link');
        assert.equal(await readFile(path.join(dir, 'INDEX.md'), 'utf8'), 'NEW CONTENT\n', 'the document was not written');
        assert.ok((await lstat(path.join(dir, 'INDEX.md'))).isFile(), 'the document is not a regular file');
        assert.deepEqual((await readdir(dir)).sort(), ['INDEX.md', 'INDEX.md.tmp'], 'a temporary file was left behind');
      });
    });
  }

  it('safeWriteFile replaces a regular document and leaves no temporary file', T, async () => {
    const { safeWriteFile } = await import(distUrl('core/tools/knowledgeHub/utils/fileUtils.js'));
    await withNested(async ({ proj }) => {
      const file = path.join(proj, 'doc.md');
      await writeFile(file, 'old');
      await safeWriteFile(file, 'new');
      assert.equal(await readFile(file, 'utf8'), 'new');
      assert.deepEqual((await readdir(proj)).sort(), ['doc.md', 'package.json']);
    });
  });
});

describe('SEC-31: document ids and version names stay inside the versions folder', () => {
  /** init, then plant two version files outside the project, in `<outer>/outside`. */
  async function plantOutsideVersions(outside) {
    await writeFile(path.join(outside, '1.0.0.yaml'), versionYaml({ version: '1.0.0', change: OUTSIDE_CANARY }));
    await writeFile(path.join(outside, '1.0.1.yaml'), versionYaml({ version: '1.0.1', change: OUTSIDE_CANARY }));
  }
  const ESCAPE_ID = '../../../outside';

  it('history with a document_id that climbs out of the versions folder reads nothing outside', T, async () => {
    await withNested(async ({ proj, outside }) => {
      await plantOutsideVersions(outside);
      const res = await withHub(proj, async call => {
        await call({ action: 'init' });
        return call({ action: 'history', document_id: ESCAPE_ID });
      });
      assert.ok(!res.text.includes(OUTSIDE_CANARY), `history listed version files from a folder outside the project:\n${res.text.slice(0, 600)}`);
      assert.match(res.text, /"success": false/, `history must report the refusal:\n${res.text.slice(0, 600)}`);
    });
  });

  it('diff with a document_id that climbs out, and version names that climb out, reads nothing outside', T, async () => {
    await withNested(async ({ proj, outside }) => {
      await plantOutsideVersions(outside);
      const res = await withHub(proj, async call => {
        await call({ action: 'init' });
        return call({ action: 'diff', document_id: ESCAPE_ID, from_version: '../../x', to_version: '../../y' });
      });
      assert.ok(!res.text.includes(OUTSIDE_CANARY), `diff showed version files from a folder outside the project:\n${res.text.slice(0, 600)}`);
    });
    await withNested(async ({ proj, outside }) => {
      await plantOutsideVersions(outside);
      const res = await withHub(proj, async call => {
        await call({ action: 'init' });
        return call({ action: 'diff', document_id: ESCAPE_ID });
      });
      assert.ok(!res.text.includes(OUTSIDE_CANARY), `diff showed version files from a folder outside the project:\n${res.text.slice(0, 600)}`);
    });
  });

  it('rollback with a version name that climbs out restores nothing from outside', T, async () => {
    await withNested(async ({ proj, outside }) => {
      await writeFile(path.join(outside, 'stolen.yaml'), versionYaml({ version: 'stolen' }).replace('old content', OUTSIDE_CANARY));
      const res = await withHub(proj, async call => {
        await call({ action: 'init' });
        return call({ action: 'rollback', document_id: 'INDEX', version: '../../../../outside/stolen' });
      });
      const index = await readFile(hubFile(proj, 'core/INDEX.md'), 'utf8');
      assert.ok(!index.includes(OUTSIDE_CANARY), 'rollback restored the text of a file outside the project');
      assert.match(res.text, /"success": false|error/i, `rollback must report the refusal:\n${res.text.slice(0, 600)}`);
    });
  });

  // Reachability through the tool. The version list also holds registry.yaml (every .yaml file in the
  // folder is listed), whose sort position depends on the order of the directory listing, so on
  // the old code this test deletes the victim for the listing order tried here, not for every order.
  // The next test calls deleteVersion directly and does not depend on the order.
  it('prune does not delete a file outside the versions folder when a version file names one', T, async () => {
    await withNested(async ({ proj, outside }) => {
      const victim = path.join(outside, 'victim.yaml');
      await writeFile(victim, 'victim\n');
      let res;
      await withHub(proj, async call => {
        await call({ action: 'init' });
        // Eleven ordinary versions and one whose own `version` field names a path. Prune keeps
        // the ten newest by file name and deletes the rest by the `version` field inside.
        const dir = path.join(proj, 'knowledge-hub', 'versions', 'INDEX');
        await mkdir(dir, { recursive: true });
        for (let n = 1; n <= 11; n++) await writeFile(path.join(dir, `1.0.${n}.yaml`), versionYaml({ version: `1.0.${n}` }));
        await writeFile(path.join(dir, '0.0.1.yaml'), versionYaml({ version: '../../../../outside/victim' }));
        // A hub INDEX.md that differs from the generated one, so update makes a version.
        await writeFile(hubFile(proj, 'core/INDEX.md'), 'text that the generator does not produce\n');
        res = await call({ action: 'update', document_id: 'INDEX', require_confirmation: false });
      });
      assert.equal(await textOrNull(victim), 'victim\n', `prune deleted a file outside the versions folder (answer: ${res.text.slice(0, 300)})`);
    });
  });

  it('VersionManager.deleteVersion and getVersion refuse a version name that climbs out of the versions folder', T, async () => {
    const { VersionManager } = await import(distUrl('core/tools/knowledgeHub/core/VersionManager.js'));
    await withNested(async ({ proj, outside }) => {
      const victim = path.join(outside, 'victim.yaml');
      await writeFile(victim, 'victim\n');
      await writeFile(path.join(outside, 'stolen.yaml'), versionYaml({ version: 'stolen' }).replace('old content', OUTSIDE_CANARY));
      const manager = new VersionManager(proj);

      let deleteError = null;
      try {
        await manager.deleteVersion('INDEX', '../../../../outside/victim');
      } catch (e) {
        deleteError = e;
      }
      assert.equal(await textOrNull(victim), 'victim\n', 'deleteVersion deleted a file outside the versions folder');
      assert.equal(deleteError?.code, 'INVALID_PATH', `deleteVersion must fail with INVALID_PATH, got ${deleteError?.code ?? 'no error'}`);

      let read = null;
      let readError = null;
      try {
        read = await manager.getVersion('INDEX', '../../../../outside/stolen');
      } catch (e) {
        readError = e;
      }
      assert.equal(JSON.stringify(read ?? {}).includes(OUTSIDE_CANARY), false, 'getVersion read a version file outside the versions folder');
      assert.equal(readError?.code, 'INVALID_PATH', `getVersion must fail with INVALID_PATH, got ${readError?.code ?? 'no error'}`);
    });
  });

  it('a registry.yaml that names a path deletes nothing outside (guard: registry.yaml is not read for names)', T, async () => {
    await withNested(async ({ proj, outside }) => {
      const victim = path.join(outside, 'victim-registry.yaml');
      await writeFile(victim, 'victim\n');
      await withHub(proj, async call => {
        await call({ action: 'init' });
        const dir = path.join(proj, 'knowledge-hub', 'versions', 'INDEX');
        await mkdir(dir, { recursive: true });
        for (let n = 1; n <= 11; n++) await writeFile(path.join(dir, `1.0.${n}.yaml`), versionYaml({ version: `1.0.${n}` }));
        await writeFile(
          path.join(dir, 'registry.yaml'),
          'document_id: INDEX\nversions:\n  - version: ../../../../outside/victim-registry\n    trigger: manual\n    author: planted\n',
        );
        await writeFile(hubFile(proj, 'core/INDEX.md'), 'text that the generator does not produce\n');
        await call({ action: 'update', document_id: 'INDEX', require_confirmation: false });
      });
      assert.equal(await textOrNull(victim), 'victim\n', 'a registry.yaml entry caused a delete outside the versions folder');
    });
  });

  it('control: history and update still work for an ordinary document', T, async () => {
    await withNested(async ({ proj }) => {
      await withHub(proj, async call => {
        await call({ action: 'init' });
        const dir = path.join(proj, 'knowledge-hub', 'versions', 'INDEX');
        await mkdir(dir, { recursive: true });
        for (let n = 1; n <= 3; n++) await writeFile(path.join(dir, `1.0.${n}.yaml`), versionYaml({ version: `1.0.${n}` }));
        const before = await call({ action: 'history', document_id: 'INDEX' });
        assert.equal(body(before)?.total_versions, 3, `history:\n${before.text.slice(0, 400)}`);
        await writeFile(hubFile(proj, 'core/INDEX.md'), 'text that the generator does not produce\n');
        const upd = await call({ action: 'update', document_id: 'INDEX', require_confirmation: false });
        assert.equal(body(upd)?.success, true, `update failed:\n${upd.text.slice(0, 400)}`);
        assert.ok(existsSync(path.join(dir, '1.0.4.yaml')), 'update must save the new version next to the old ones');
      });
    });
  });
});

describe('SEC-31: containedJoin and getVersionsPath (support tests: new function)', () => {
  it('containedJoin returns a path strictly inside the base, otherwise null', async () => {
    const { containedJoin } = await import(distUrl('core/tools/knowledgeHub/utils/configUtils.js'));
    assert.equal(containedJoin('/p/base', 'a.yaml'), '/p/base/a.yaml');
    assert.equal(containedJoin('/p/base', 'a/b.yaml'), '/p/base/a/b.yaml', 'a separator inside the name is fine when the result stays inside');
    assert.equal(containedJoin('/p/base', 'a/../b.yaml'), '/p/base/b.yaml');
    for (const bad of ['../x', '../../x.yaml', 'a/../../x', '', '.', '..', 'a\0b', '../base-evil/x']) {
      assert.equal(containedJoin('/p/base', bad), null, `${JSON.stringify(bad)} must be refused`);
    }
  });

  it('getVersionsPath keeps an ordinary id inside the versions folder and throws for an id that climbs out', async () => {
    const { getVersionsPath } = await import(distUrl('core/tools/knowledgeHub/utils/configUtils.js'));
    assert.equal(getVersionsPath('/p'), '/p/knowledge-hub/versions');
    assert.equal(getVersionsPath('/p', 'INDEX'), '/p/knowledge-hub/versions/INDEX');
    for (const bad of ['../x', '../../../outside', '..', '.', 'a\0b']) {
      assert.throws(() => getVersionsPath('/p', bad), error => error.code === 'INVALID_PATH', `${JSON.stringify(bad)} must throw INVALID_PATH`);
    }
  });
});

// ---------------------------------------------------------------------------
// registry.yaml is not a version
// ---------------------------------------------------------------------------

// `getHistory` listed every `.yaml` file in a document's versions folder, and `registry.yaml` is
// one of them. `history` then showed a second entry with the version `undefined`, and the tenth
// version of a document failed in the prune step with `Version undefined not found`.

const VERSION_NAME = /^\d+\.\d+\.\d+$/;

describe('knowledge_hub: registry.yaml is not a version', () => {
  const versionsDir = proj => path.join(proj, 'knowledge-hub', 'versions', 'INDEX');
  /** Make the hub INDEX.md differ from the generated one, so the next update saves a version. */
  const editIndex = (proj, n) => writeFile(hubFile(proj, 'core/INDEX.md'), `text that the generator does not produce, round ${n}\n`);

  it('history after one update lists one version and no registry entry', T, async () => {
    await withNested(async ({ proj }) => {
      let history;
      await withHub(proj, async call => {
        await call({ action: 'init' });
        await editIndex(proj, 1);
        const upd = await call({ action: 'update', document_id: 'INDEX', require_confirmation: false });
        assert.equal(body(upd)?.success, true, `update failed:\n${upd.text.slice(0, 400)}`);
        history = body(await call({ action: 'history', document_id: 'INDEX' }));
      });
      assert.deepEqual(history?.versions?.map(v => v.version), ['1.0.0'], `history must list exactly the one saved version:\n${JSON.stringify(history)}`);
      assert.equal(history?.total_versions, 1);
      assert.ok(history.versions.every(v => !Number.isNaN(Date.parse(v.created_at))), 'a history entry has an invalid date');
    });
  });

  it('eleven updates on one document all succeed, history lists ten versions, prune keeps ten and registry.yaml stays', T, async () => {
    await withNested(async ({ proj }) => {
      const results = [];
      let history;
      await withHub(proj, async call => {
        await call({ action: 'init' });
        for (let n = 1; n <= 11; n++) {
          await editIndex(proj, n);
          results.push(await call({ action: 'update', document_id: 'INDEX', require_confirmation: false }));
        }
        history = body(await call({ action: 'history', document_id: 'INDEX' }));
      });

      const failed = results.map((r, i) => [i + 1, body(r)]).filter(([, b]) => b?.success !== true).map(([n, b]) => `update ${n}: ${b?.message ?? b?.error ?? 'no JSON answer'}`);
      assert.deepEqual(failed, [], 'every update must succeed');

      const expected = Array.from({ length: 10 }, (_, i) => `1.0.${10 - i}`); // newest first; 1.0.0 was pruned
      assert.deepEqual(history?.versions?.map(v => v.version), expected, `history must list the ten newest versions, no registry entry:\n${JSON.stringify(history)}`);
      assert.ok(history.versions.every(v => !Number.isNaN(Date.parse(v.created_at))), 'a history entry has an invalid date');

      const names = (await readdir(versionsDir(proj))).sort();
      assert.deepEqual(names, [...expected.map(v => `${v}.yaml`), 'registry.yaml'].sort(), 'the folder must hold the ten newest versions and registry.yaml');
    });
  });

  it('VersionManager.getHistory lists only version files, and prune keeps ten of eleven', T, async () => {
    const { VersionManager } = await import(distUrl('core/tools/knowledgeHub/core/VersionManager.js'));
    await withNested(async ({ proj }) => {
      const manager = new VersionManager(proj);
      const failures = [];
      for (let n = 1; n <= 11; n++) {
        try {
          await manager.createVersion({ id: 'INDEX', content: `content ${n}` }, { changes: [`round ${n}`], trigger: 'manual', author: 'system' });
        } catch (e) {
          failures.push(`createVersion ${n}: ${e.message}`);
        }
      }
      assert.deepEqual(failures, [], 'every createVersion must succeed');

      const history = await manager.getHistory('INDEX', 999);
      assert.equal(history.length, 10, `getHistory must list ten versions, got ${history.map(v => v.version).join(', ')}`);
      assert.ok(history.every(v => VERSION_NAME.test(v.version)), `a history entry is not a version: ${history.map(v => v.version).join(', ')}`);
      assert.equal(await manager.getLatestVersion('INDEX'), '1.0.10');
      assert.ok(existsSync(path.join(versionsDir(proj), 'registry.yaml')), 'registry.yaml was removed');
      assert.ok(!existsSync(path.join(versionsDir(proj), '1.0.0.yaml')), 'the oldest version must be pruned');
    });
  });
});
