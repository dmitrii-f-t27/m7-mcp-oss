/**
 * SEC-5 (MEDIUM): M7_PROJECT_PATH beats the Cursor activity scan.
 *
 * Order after this fix:
 *   1. explicit project_path          5. M7_PROJECT_PATH
 *   2. MCP Roots                      6. Cursor activity scan, only when
 *   3. CURSOR_WORKSPACE /                M7_PROJECT_PATH is unset or invalid
 *      WORKSPACE_FOLDER_PATHS            and cwd is bare home or the install
 *   4. AGENT_TRANSCRIPTS                 directory
 *                                     7. process.cwd()
 *
 * Same style as tests/projectPath.test.mjs: the tests call the built module
 * (dist/core/utils/projectPath.js) in process and set the environment by hand.
 * That file stays as it is and must keep passing: M7_PROJECT_PATH still needs
 * the Roots step to be finished before the synchronous getProjectPath() uses it.
 *
 * HOME and USERPROFILE point at a throwaway directory, so the scan fixtures
 * (a project under <home>/Documents/dev and a slug directory that names it)
 * never touch the real home directory.
 *
 * The test of the pure decision function imports the export inside the test, so
 * a missing export fails only that test and never hides the others.
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-project-path.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..'); // the install directory
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

// Throwaway home. realpath, because process.cwd() after chdir returns the real path
// and the module compares cwd with homedir() as plain strings.
const HOME = realpathSync(mkdtempSync(path.join(tmpdir(), 'm7-sec-pp-home-')));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
assert.equal(homedir(), HOME, 'the test needs os.homedir() to follow HOME');

const pp = await import('../dist/core/utils/projectPath.js');

const ENV_KEYS = [
  'M7_PROJECT_PATH',
  'CURSOR_WORKSPACE',
  'WORKSPACE_FOLDER_PATHS',
  'AGENT_TRANSCRIPTS',
  'CURSOR_PROJECTS_DIR',
];

const homeSlug = () => homedir().replace(/^(?:[A-Za-z]:)?[\\/]/, '').replace(/[\\/]/g, '-');

const cleanup = [];
let counter = 0;

function makeProjectDir(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  writeFileSync(path.join(dir, 'package.json'), '{}');
  cleanup.push(dir);
  return dir;
}

/**
 * A workspace that only the activity scan can find: a project under the fake
 * home, plus a Cursor projects directory with recent transcripts for its slug.
 * Sets CURSOR_PROJECTS_DIR. Returns the project path.
 */
function makeScanTarget() {
  const name = `ScanTarget${++counter}`;
  const project = path.join(HOME, 'Documents', 'dev', name);
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'package.json'), '{}');
  const projectsRoot = mkdtempSync(path.join(tmpdir(), 'm7-sec-pp-projects-'));
  cleanup.push(projectsRoot);
  const slugDir = path.join(projectsRoot, `${homeSlug()}-Documents-dev-${name}`);
  mkdirSync(path.join(slugDir, 'agent-transcripts'), { recursive: true });
  writeFileSync(path.join(slugDir, 'agent-transcripts', 'recent.jsonl'), '{"event":"test"}\n');
  process.env.CURSOR_PROJECTS_DIR = projectsRoot;
  return project;
}

/** A client whose roots/list call always fails. */
const failingRootsServer = () => ({
  server: {
    listRoots: async () => {
      throw new Error('roots unavailable');
    },
  },
});

/** cwd values for which the scan is allowed to answer: bare home and the install directory. */
const SCAN_CWDS = [
  ['bare home', HOME],
  ['the install directory', ROOT],
];

function resetState() {
  pp.resetProjectPathStateForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.chdir(ORIGINAL_CWD);
}

/** Registers the per-test reset inside the calling describe block. */
function useCleanState() {
  beforeEach(resetState);
  afterEach(resetState);
}

after(() => {
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------

describe('SEC-5: M7_PROJECT_PATH vs the Cursor activity scan', () => {
  useCleanState();

  for (const [label, cwd] of SCAN_CWDS) {
    it(`M7_PROJECT_PATH beats the activity scan after Roots (cwd: ${label})`, () => {
      const m7 = makeProjectDir('m7-sec-pp-m7-');
      const scanned = makeScanTarget();
      process.env.M7_PROJECT_PATH = m7;
      process.chdir(cwd);

      pp.markRootsResolutionComplete();
      pp.clearProjectPathCache();
      const got = pp.getProjectPath();

      assert.notEqual(got, scanned, 'the activity scan must not answer when M7_PROJECT_PATH is valid');
      assert.equal(got, m7);
    });
  }

  for (const [label, cwd] of SCAN_CWDS) {
    it(`ensureProjectPathResolved returns M7_PROJECT_PATH on the first call when Roots fail (cwd: ${label})`, async () => {
      const m7 = makeProjectDir('m7-sec-pp-m7-');
      const scanned = makeScanTarget();
      process.env.M7_PROJECT_PATH = m7;
      process.chdir(cwd);

      const first = await pp.ensureProjectPathResolved(failingRootsServer());

      assert.notEqual(first, scanned, 'the activity scan must not answer on the first call');
      assert.equal(first, m7);
      assert.equal(pp.isRootsResolutionComplete(), true, 'a resolved M7_PROJECT_PATH ends the Roots wait');
      assert.equal(pp.getProjectPath(), m7, 'getProjectPath() must agree with the call that just resolved');
    });
  }

  it('the scan does not beat a usable cwd', async () => {
    const usable = makeProjectDir('m7-sec-pp-cwd-');
    const scanned = makeScanTarget();
    process.chdir(usable);
    const cwd = process.cwd();

    // Before Roots finish.
    assert.equal(pp.getProjectPath(), cwd, 'getProjectPath() before Roots');
    assert.equal(await pp.ensureProjectPathResolved(failingRootsServer()), cwd, 'first call with failing Roots');

    // After Roots finish.
    pp.resetProjectPathStateForTests();
    pp.markRootsResolutionComplete();
    const later = pp.getProjectPath();
    assert.notEqual(later, scanned);
    assert.equal(later, cwd, 'getProjectPath() after Roots');
  });

  for (const [label, cwd] of SCAN_CWDS) {
    it(`before Roots finish the scan does not beat a set M7_PROJECT_PATH (cwd: ${label})`, () => {
      const m7 = makeProjectDir('m7-sec-pp-m7-');
      const scanned = makeScanTarget();
      process.env.M7_PROJECT_PATH = m7;
      process.chdir(cwd);

      assert.equal(pp.isRootsResolutionComplete(), false);
      const before = pp.getProjectPath();
      assert.notEqual(before, scanned, 'the activity scan must not answer while M7_PROJECT_PATH is set');
      assert.notEqual(before, m7, 'M7_PROJECT_PATH still waits for the Roots step (tests/projectPath.test.mjs)');

      pp.markRootsResolutionComplete();
      pp.clearProjectPathCache();
      assert.equal(pp.getProjectPath(), m7, 'after Roots finish M7_PROJECT_PATH applies');
    });
  }

  it('diagnostics report source M7_PROJECT_PATH', () => {
    const m7 = makeProjectDir('m7-sec-pp-m7-');
    const scanned = makeScanTarget();
    process.env.M7_PROJECT_PATH = m7;
    process.chdir(HOME);

    pp.markRootsResolutionComplete();
    pp.clearProjectPathCache();
    const diag = pp.getProjectPathDiagnostics();
    assert.equal(diag.source, 'M7_PROJECT_PATH');
    assert.equal(diag.currentPath, m7);
    assert.notEqual(diag.currentPath, scanned);

    // Before Roots finish the diagnostics must not name the scan either.
    pp.resetProjectPathStateForTests();
    const early = pp.getProjectPathDiagnostics();
    assert.notEqual(early.source, 'Cursor projects dir');
    assert.notEqual(early.currentPath, scanned);
  });

  it('the pure source decision follows the documented order', async () => {
    const { selectProjectSource } = await import('../dist/core/utils/projectPath.js');
    assert.equal(typeof selectProjectSource, 'function', 'projectPath.js must export selectProjectSource');

    const base = {
      hasCursorEnv: false,
      hasAgentTranscripts: false,
      hasValidM7Path: false,
      rootsComplete: false,
      cwdAllowsScan: false,
    };
    const table = [
      // [facts, expected source, why]
      [{ hasCursorEnv: true, hasAgentTranscripts: true, hasValidM7Path: true, rootsComplete: true, cwdAllowsScan: true }, 'CURSOR env', 'CURSOR_WORKSPACE first'],
      [{ hasAgentTranscripts: true, hasValidM7Path: true, rootsComplete: true, cwdAllowsScan: true }, 'AGENT_TRANSCRIPTS', 'AGENT_TRANSCRIPTS before M7_PROJECT_PATH'],
      [{ hasValidM7Path: true, rootsComplete: true, cwdAllowsScan: true }, 'M7_PROJECT_PATH', 'M7_PROJECT_PATH before the scan'],
      [{ hasValidM7Path: true, rootsComplete: true }, 'M7_PROJECT_PATH', 'M7_PROJECT_PATH with a plain cwd'],
      [{ hasValidM7Path: true, rootsComplete: false, cwdAllowsScan: true }, 'process.cwd()', 'before Roots: not the scan, not M7_PROJECT_PATH'],
      [{ hasValidM7Path: true, rootsComplete: false }, 'process.cwd()', 'before Roots with a plain cwd'],
      [{ cwdAllowsScan: true }, 'Cursor projects dir', 'scan when M7_PROJECT_PATH is unset or invalid'],
      [{ cwdAllowsScan: true, rootsComplete: true }, 'Cursor projects dir', 'scan after Roots too'],
      [{ rootsComplete: true }, 'process.cwd()', 'the scan does not beat a usable cwd'],
      [{}, 'process.cwd()', 'nothing set'],
    ];
    for (const [facts, expected, why] of table) {
      assert.equal(selectProjectSource({ ...base, ...facts }), expected, why);
    }
  });
});

// ---------------------------------------------------------------------------
// Guards: behaviour that must not change (these pass before and after the fix)
// ---------------------------------------------------------------------------

describe('SEC-5 guards: the rest of the order is unchanged', () => {
  useCleanState();

  for (const [label, cwd] of SCAN_CWDS) {
    it(`the scan still answers when M7_PROJECT_PATH is unset (cwd: ${label})`, () => {
      const scanned = makeScanTarget();
      process.chdir(cwd);
      pp.markRootsResolutionComplete();
      pp.clearProjectPathCache();
      assert.equal(pp.getProjectPath(), scanned);
    });

    it(`the scan still answers when M7_PROJECT_PATH is a missing directory (cwd: ${label})`, () => {
      const scanned = makeScanTarget();
      process.env.M7_PROJECT_PATH = path.join(HOME, 'does-not-exist');
      process.chdir(cwd);
      pp.markRootsResolutionComplete();
      pp.clearProjectPathCache();
      assert.equal(pp.getProjectPath(), scanned);
    });
  }

  it('CURSOR_WORKSPACE still beats M7_PROJECT_PATH', () => {
    const workspace = makeProjectDir('m7-sec-pp-ws-');
    process.env.CURSOR_WORKSPACE = workspace;
    process.env.M7_PROJECT_PATH = makeProjectDir('m7-sec-pp-m7-');
    pp.markRootsResolutionComplete();
    pp.clearProjectPathCache();
    assert.equal(pp.getProjectPath(), workspace);
  });

  it('AGENT_TRANSCRIPTS still beats M7_PROJECT_PATH', () => {
    const decoded = path.join(HOME, 'Documents', 'dev', 'TranscriptTarget');
    mkdirSync(decoded, { recursive: true });
    writeFileSync(path.join(decoded, 'package.json'), '{}');
    process.env.AGENT_TRANSCRIPTS = path.join(
      HOME, '.cursor', 'projects', `${homeSlug()}-Documents-dev-TranscriptTarget`, 'agent-transcripts',
    );
    process.env.M7_PROJECT_PATH = makeProjectDir('m7-sec-pp-m7-');
    pp.markRootsResolutionComplete();
    pp.clearProjectPathCache();
    assert.equal(pp.getProjectPath(), decoded);
  });
});
