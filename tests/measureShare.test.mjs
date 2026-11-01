// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * scripts/measure-t27-share.mjs: the boundary and logic classifier, the share, and the rules for
 * specs/MOVED.tsv.
 *
 * The classifier is tested on a small fixture whose every line class and point is written out here.
 * Share and scope are tested on a throwaway git repository. The MOVED.tsv rules are tested one by one
 * on throwaway repositories, and the real specs/MOVED.tsv is checked against them: a row that fails a
 * rule fails this file.
 *
 * Everything is written under the system temp directory, never into the repository.
 *
 * Run: node --test --test-force-exit tests/measureShare.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_OPT, analyzeSource, checkMoved, listSources, measure, parseMoved, sampleLines, shareOf, symbolPoints,
} from '../scripts/measure-t27-share.mjs';

// Read apart from the import list above: a missing export then fails one test and not the whole file.
const { BASE_REV, resolveRev, shareNumbers } = await import('../scripts/measure-t27-share.mjs');

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'measure-t27-share.mjs');
const T = { timeout: 120_000 };

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

/** A throwaway git repository; `files` is { path: text }. */
function makeRepo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'measure-share-'));
  made.push(dir);
  git(dir, 'init', '-q');
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    if (text === null) rmSync(path.join(dir, rel), { force: true });
    else writeFileSync(path.join(dir, rel), text);
  }
}

function commit(dir, files, message = 'next') {
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', '--short', 'HEAD');
}

function cli(dir, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

// ---------------------------------------------------------------------------
// The classifier, line by line
// ---------------------------------------------------------------------------

const FIXTURE = [
  "import { join } from 'path';",
  'export interface Opts {',
  '  name: string;',
  '}',
  "const LIMITS = { max: 3, names: ['a', 'b'] };",
  'const RE = /^a+$/;',
  '/** A comment line is not code. */',
  'export function pick(opts: Opts | null, n: number): string {',
  '  if (!opts) {',
  "    return '';",
  '  }',
  '  if (n > LIMITS.max && opts.name) {',
  '    return opts.name.trim();',
  '  }',
  "  const label = n > 1 ? 'many' : 'one';",
  '  for (const x of LIMITS.names) {',
  '    if (x === label) break;',
  '  }',
  "  const p = join('a', 'b');",
  '  return `${label}-${p}`;',
  '}',
  'export function plain(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
].join('\n');

describe('classifier on a fixture', () => {
  const a = analyzeSource(FIXTURE, 'src/fixture.ts');

  it('gives each code line one class and leaves closers and comments out', () => {
    assert.deepEqual(a.lines.slice(0, 24), [
      'type', 'type', 'type', null,           // import, interface
      'data', 'logic',                         // top-level literal const; a regex is logic, not data
      null,                                    // comment
      'glue', 'logic', 'glue', null,           // function header, if, return, }
      'logic', 'logic', null,                  // if with &&, trim, }
      'logic', 'logic', 'logic', null,         // ?:, for, if in the loop, }
      'boundary', 'text', null,                // join imported from path, template literal, }
      'glue', 'logic', null,                   // function header, a + b, }
    ]);
  });

  it('counts decisions, regex literals, transforms and guards apart', () => {
    // decisions: if, &&, ?:, for, if (x === label) = 5. guard: if (!opts). regex: 1. transform: trim.
    assert.deepEqual(a.counts, { decisions: 5, regexLiterals: 1, transforms: 1, guards: 1 });
  });

  it('a binary operator makes a logic line but not a logic point', () => {
    const plain = a.functions.find(f => f.qname === 'plain');
    assert.equal(plain.points, 0);
    assert.equal(a.lines[22], 'logic');
  });

  it('finds functions with their points and effects', () => {
    const pick = a.functions.find(f => f.qname === 'pick');
    assert.equal(pick.points, 6, 'five decisions and one transform');
    assert.deepEqual([...pick.effects], ['boundary'], 'join comes from path');
    assert.deepEqual(a.functions.map(f => f.qname), ['pick', 'plain']);
  });

  it('counts a comment as code only when asked to', () => {
    const c = analyzeSource(FIXTURE, 'src/fixture.ts', { ...DEFAULT_OPT, commentLines: true });
    assert.equal(c.lines[6], 'glue');
    assert.equal(a.lines[6], null);
  });

  it('class members have a qualified name, nested functions add their points to the outer one', () => {
    const src = [
      'export class Gate {',
      '  check(n: number): boolean {',
      '    const inner = (m: number) => m > 2 && m < 9;',
      '    return inner(n) ? true : false;',
      '  }',
      '  other = (x: number) => x.toString().trim();',
      '}',
      '',
    ].join('\n');
    const r = analyzeSource(src, 'src/gate.ts');
    const byName = Object.fromEntries(r.functions.map(f => [f.qname, f.points]));
    assert.deepEqual(byName, { 'Gate.check': 2, inner: 1, 'Gate.other': 1 }, 'check holds its ?: and the && of the nested arrow; the toString call is no transform');
  });

  it('data: zod, inputSchema and description; a regex or a call is not a literal tree', () => {
    const src = [
      "import { z } from 'zod';",
      'export const Schema = z.object({',
      '  a: z.string(),',
      '});',
      "const TABLE = ['a', 'b'];",
      'const PATTERNS = [/a/, /b/];',
      'const MADE = makeTable();',
      'export const tool = {',
      "  description: 'text',",
      '  inputSchema: {',
      "    type: 'object',",
      '  },',
      '  run() {',
      '    return 1;',
      '  },',
      '};',
      '',
    ].join('\n');
    const r = analyzeSource(src, 'src/data.ts').lines;
    assert.deepEqual(r.slice(0, 16), [
      'type', 'data', 'data', null,
      'data', 'logic', 'glue',
      'glue', 'data', 'data', 'data', null,
      'glue', 'glue', null, null,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scope and share, on a throwaway repository
// ---------------------------------------------------------------------------

describe('scope and share', () => {
  const WASM = 'export function load() {\n  return WebAssembly.compile(new Uint8Array(0));\n}\n';
  const dir = makeRepo({
    'src/a.ts': FIXTURE,
    'src/__tests__/skip.test.ts': 'if (process.env.X) { console.log(1); }\n',
    'src/rules/wasm.ts': WASM,
    'src/notes.md': '# not typescript\n',
    'docs/readme.md': 'x\n',
  });
  const baseSha = git(dir, 'rev-parse', '--short', 'HEAD');
  // Remove the for loop and the if inside it: two decisions less.
  const smaller = FIXTURE.replace("  for (const x of LIMITS.names) {\n    if (x === label) break;\n  }\n", '');
  assert.notEqual(smaller, FIXTURE);
  commit(dir, { 'src/a.ts': smaller });

  it('lists tracked src .ts files, minus __tests__', () => {
    assert.deepEqual(listSources(dir, 'HEAD'), ['src/a.ts', 'src/rules/wasm.ts']);
  });

  it('reports src/rules/wasm.ts apart, as boundary, and out of the classes', () => {
    const r = measure({ repo: dir, rev: 'HEAD' });
    assert.equal(r.files, 1);
    assert.equal(r.boundaryFiles.files, 1);
    assert.equal(r.boundaryFiles.codeLines, 2, 'the closing brace is not a code line');
  });

  it('measures a past revision with git show, not the working tree', () => {
    const base = measure({ repo: dir, rev: baseSha });
    const now = measure({ repo: dir, rev: 'HEAD' });
    assert.equal(base.total.points, 7);
    assert.equal(now.total.points, 5);
    assert.equal(base.total.codeLines - now.total.codeLines, 2, 'the two removed code lines');
  });

  it('classes add up to the code lines, and points to their three parts', () => {
    const t = measure({ repo: dir, rev: 'HEAD' }).total;
    assert.equal(t.type + t.data + t.text + t.boundary + t.glue + t.logic, t.codeLines);
    assert.equal(t.decisions + t.regexLiterals + t.transforms, t.points);
    assert.equal(t.pure + t.effectful, t.functionsWithPoint);
  });

  it('share is (base points - points now) / base points', () => {
    assert.equal(shareOf(7, 5), 2 / 7);
    assert.equal(shareOf(0, 5), 0);
    const r = cli(dir, '--rev', 'HEAD', '--base-rev', baseSha, '--json');
    assert.equal(r.status, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.base.points, 7);
    assert.equal(j.total.points, 5);
    assert.equal(j.share, 2 / 7);
    const text = cli(dir, '--rev', 'HEAD', '--base-rev', baseSha);
    assert.match(text.out, /Share moved to t27: 28\.57% = \(7 - 5\) \/ 7/);
  });

  it('says so when the base revision is not in the repository', () => {
    const r = cli(dir, '--rev', 'HEAD', '--base-rev', 'deadbee');
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Share moved to t27: n\/a/);
  });

  it('a bad option exits with 2', () => {
    assert.equal(cli(dir, '--no-such-option').status, 2);
    assert.equal(cli(dir, '--sample', 'many').status, 2);
  });

  it('the sample is seeded: same seed, same lines; another seed, other lines', () => {
    const r = measure({ repo: dir, rev: 'HEAD' });
    const a = sampleLines(r, 6, 27);
    assert.deepEqual(sampleLines(r, 6, 27), a);
    assert.notDeepEqual(sampleLines(r, 6, 28).map(s => s.line), a.map(s => s.line));
    assert.equal(a.length, 6);
    assert.equal(new Set(a.map(s => `${s.file}:${s.line}`)).size, 6, 'distinct lines');
    for (const s of a) assert.ok(['type', 'data', 'logic', 'text', 'boundary', 'glue'].includes(s.cls));
    assert.equal(sampleLines(r, 500, 27).length, r.total.codeLines, 'asking for more than there is returns every code line');
    const cliA = cli(dir, '--rev', 'HEAD', '--sample', '6', '--seed', '27');
    assert.deepEqual(cliA.out.trim().split('\n').map(l => l.split('\t').slice(0, 2).join(' ')), a.map(s => `${s.file}:${s.line} ${s.cls}`));
  });
});

describe('boundary files', () => {
  const dir = makeRepo({
    'src/a.ts': FIXTURE,
    'src/rules/wasm.ts': 'export function load(n: number) {\n  return n > 1 ? WebAssembly.compile(new Uint8Array(n)) : null;\n}\n',
    'src/rules/marshal.ts': 'export const f = (a: string) => a.trim();\n',
  });

  it('reports the logic points of the boundary files apart, and keeps them out of the denominator', () => {
    const r = measure({ repo: dir, rev: 'HEAD' });
    assert.equal(r.boundaryFiles.files, 2);
    assert.equal(r.boundaryFiles.points, 2, 'one ?: in wasm.ts and one trim in marshal.ts');
    assert.equal(r.total.points, 7, 'src/a.ts alone');
    const json = JSON.parse(cli(dir, '--rev', 'HEAD', '--json').out);
    assert.equal(json.boundaryFiles.points, 2);
    assert.match(cli(dir, '--rev', 'HEAD').out, /boundary files apart: 2 \(\d+ code lines, 2 logic points\)/);
  });
});

describe('WORKTREE reads files that git does not track yet', () => {
  it('lists an untracked source, and leaves out an ignored one', () => {
    const dir = makeRepo({ 'src/a.ts': 'export const a = 1;\n', '.gitignore': 'src/ignored.ts\n' });
    writeFiles(dir, { 'src/new.ts': 'export const b = 2;\n', 'src/ignored.ts': 'export const c = 3;\n' });
    assert.deepEqual(listSources(dir, 'WORKTREE'), ['src/a.ts', 'src/new.ts']);
    assert.deepEqual(listSources(dir, 'HEAD'), ['src/a.ts']);
  });

  it('sees a spec and an exports list that are not tracked yet', () => {
    const { dir } = movedRepo();
    git(dir, 'rm', '-q', '--cached', 'specs/foo.t27', 'specs/exports.txt');
    assert.equal(git(dir, 'ls-files', 'specs'), 'specs/MOVED.tsv', 'the spec and the exports list are now untracked');
    const [res] = checkMoved({ repo: dir, rev: 'WORKTREE' });
    assert.deepEqual(res.failures, []);
    assert.equal(res.ok, true);
  });
});

// ---------------------------------------------------------------------------
// The real repository
// ---------------------------------------------------------------------------

describe('the real repository', () => {
  it('measures src without a parse problem and its numbers add up', T, () => {
    const r = measure({ repo: ROOT, rev: 'WORKTREE' });
    const t = r.total;
    assert.ok(r.files > 200, `${r.files} files`);
    assert.ok(t.points > 5000 && t.regexLiterals > 0 && t.guards > 0, JSON.stringify(t));
    assert.equal(t.type + t.data + t.text + t.boundary + t.glue + t.logic, t.codeLines);
    assert.equal(t.decisions + t.regexLiterals + t.transforms, t.points);
  });

  it('specs/MOVED.tsv has the header and every row passes the four rules', () => {
    const text = readFileSync(path.join(ROOT, 'specs', 'MOVED.tsv'), 'utf8');
    assert.equal(text.split('\n').find(l => !l.startsWith('#')), 'spec_fn\tsource_file\tsource_symbol\tbase_rev\toracle_file\ttest_file');
    const results = checkMoved({ repo: ROOT, rev: 'WORKTREE' });
    const bad = results.filter(r => !r.ok).map(r => `${r.row.spec_fn}: ${r.failures.join('; ')}`);
    assert.deepEqual(bad, [], `MOVED.tsv rows that fail:\n${bad.join('\n')}`);
  });
});

// ---------------------------------------------------------------------------
// MOVED.tsv rules
// ---------------------------------------------------------------------------

const SOURCE_BEFORE = [
  'export class Gate {',
  '  check(n: number): boolean {',
  '    if (n > 3 && n < 9) {',
  '      return true;',
  '    }',
  '    return false;',
  '  }',
  '}',
  'export function classify(n: number): string {',
  "  return n > 1 ? 'big' : 'small';",
  '}',
  '',
].join('\n');

const SOURCE_AFTER = [
  'export class Gate {',
  '  check(n: number): boolean {',
  '    return callSpec(n);',
  '  }',
  '}',
  'export function classify(n: number): string {',
  '  return callSpec(n);',
  '}',
  '',
].join('\n');

const SPEC = [
  '// spec',
  'pub fn foo_pick(n: i32) -> i32 {',
  '  return foo_inner(n);',
  '}',
  'pub fn foo_inner(n: i32) -> i32 {',
  '  return n;',
  '}',
  'pub fn foo_hidden(n: i32) -> i32 {',
  '  return n;',
  '}',
  'fn foo_private(n: i32) -> i32 {',
  '  return n;',
  '}',
  '',
].join('\n');

const HEADER = 'spec_fn\tsource_file\tsource_symbol\tbase_rev\toracle_file\ttest_file';
const ORACLE = (sha, source = 'src/legacy.ts') => `// Oracle: the old rules of ${source}, copied from commit ${sha}.\nexport function check(n) {\n  return n > 3 && n < 9;\n}\n`;
const TEST = "import { check } from './oracle/legacyOracle.mjs';\ncheck(4);\n";

/**
 * A repository with a base commit (the logic in TypeScript) and a second commit that moves it: a spec,
 * an oracle, a test and one MOVED.tsv row. `mutate(dir, sha)` then breaks one thing in the working tree.
 */
function movedRepo({ row = {}, more = [], mutate } = {}) {
  const dir = makeRepo({ 'src/legacy.ts': SOURCE_BEFORE });
  const sha = git(dir, 'rev-parse', '--short', 'HEAD');
  const r = { spec_fn: 'foo_pick', source_file: 'src/legacy.ts', source_symbol: 'Gate.check', base_rev: sha, oracle_file: 'tests/oracle/legacyOracle.mjs', test_file: 'tests/foo.test.mjs', ...row };
  commit(dir, {
    'src/legacy.ts': SOURCE_AFTER,
    'specs/foo.t27': SPEC,
    'specs/exports.txt': '# exported\nfoo_pick\n',
    'specs/MOVED.tsv': `${HEADER}\n${[r, ...more.map(m => ({ ...r, ...m }))].map(x => Object.values(x).join('\t')).join('\n')}\n`,
    'tests/oracle/legacyOracle.mjs': ORACLE(sha),
    'tests/foo.test.mjs': TEST,
  });
  if (mutate) {
    mutate(dir, sha);
    git(dir, 'add', '-A');
  }
  return { dir, sha, rev: mutate ? 'WORKTREE' : 'HEAD' };
}

function check(opts) {
  const { dir, rev, sha } = movedRepo(opts);
  const [res] = checkMoved({ repo: dir, rev });
  return { ...res, dir, sha };
}

describe('MOVED.tsv rules', () => {
  it('a row that meets all four rules counts, with the points its symbol held at base_rev', () => {
    const r = check();
    assert.deepEqual(r.failures, []);
    assert.equal(r.ok, true);
    assert.equal(r.points, 2, 'if and && in Gate.check at the base commit');
  });

  it('points are those of the named symbol only', () => {
    const r = check({ row: { source_symbol: 'classify' } });
    assert.deepEqual(r.failures, []);
    assert.equal(r.points, 1, 'the ?: in classify');
  });

  describe('rule 1: a pub fn in a spec, exported', () => {
    it('fails when the spec has no pub fn of that name', () => {
      const r = check({ row: { spec_fn: 'no_such_fn' } });
      assert.equal(r.ok, false);
      assert.match(r.failures.join('\n'), /^1: no `pub fn no_such_fn`/m);
    });

    it('fails when the function is not pub', () => {
      const r = check({ row: { spec_fn: 'foo_private' } });
      assert.match(r.failures.join('\n'), /^1: no `pub fn foo_private`/m);
    });

    it('fails when the pub fn is not in exports.txt and no exported function calls it', () => {
      const r = check({ row: { spec_fn: 'foo_hidden' } });
      assert.match(r.failures.join('\n'), /^1: foo_hidden is not in specs\/exports\.txt/m);
    });

    it('passes when an exported function calls it', () => {
      const r = check({ row: { spec_fn: 'foo_inner' } });
      assert.deepEqual(r.failures, []);
    });

    it('fails when exports.txt lists nothing', () => {
      const r = check({ mutate: dir => writeFiles(dir, { 'specs/exports.txt': '# nothing\n' }) });
      assert.match(r.failures.join('\n'), /^1: foo_pick is not in specs\/exports\.txt/m);
    });
  });

  describe('rule 2: the source symbol is gone or holds no logic points', () => {
    it('fails when the symbol still holds logic points', () => {
      const r = check({ mutate: dir => writeFiles(dir, { 'src/legacy.ts': SOURCE_BEFORE }) });
      assert.match(r.failures.join('\n'), /^2: Gate\.check still holds 2 logic points in src\/legacy\.ts/m);
    });

    it('passes when the symbol is gone', () => {
      const r = check({ mutate: dir => writeFiles(dir, { 'src/legacy.ts': 'export class Gate {}\n' }) });
      assert.deepEqual(r.failures, []);
    });

    it('passes when the whole file is gone', () => {
      const r = check({ mutate: dir => writeFiles(dir, { 'src/legacy.ts': null }) });
      assert.deepEqual(r.failures, []);
    });

    it('a different symbol of the same name in another class does not count', () => {
      const r = check({ mutate: dir => writeFiles(dir, { 'src/legacy.ts': `${SOURCE_AFTER}export class Other {\n  check(n: number) {\n    return n > 1 ? 1 : 2;\n  }\n}\n` }) });
      assert.deepEqual(r.failures, []);
    });
  });

  describe('rule 3: the oracle exists and its header names the source and the commit', () => {
    it('fails when the oracle file does not exist', () => {
      const r = check({ mutate: dir => writeFiles(dir, { 'tests/oracle/legacyOracle.mjs': null }) });
      assert.match(r.failures.join('\n'), /^3: oracle tests\/oracle\/legacyOracle\.mjs does not exist/m);
    });

    it('fails when the header does not name the source file', () => {
      const r = check({ mutate: (dir, sha) => writeFiles(dir, { 'tests/oracle/legacyOracle.mjs': ORACLE(sha, 'src/other.ts') }) });
      assert.match(r.failures.join('\n'), /^3: the header of tests\/oracle\/legacyOracle\.mjs does not name src\/legacy\.ts/m);
    });

    it('fails when the header does not name the commit', () => {
      const r = check({ mutate: dir => writeFiles(dir, { 'tests/oracle/legacyOracle.mjs': ORACLE('0000000') }) });
      assert.match(r.failures.join('\n'), /^3: the header of tests\/oracle\/legacyOracle\.mjs does not name commit /m);
    });

    it('fails when the commit is only named below the first 30 lines', () => {
      const r = check({ mutate: (dir, sha) => writeFiles(dir, { 'tests/oracle/legacyOracle.mjs': `${'// filler\n'.repeat(40)}${ORACLE(sha)}` }) });
      assert.match(r.failures.join('\n'), /^3: /m);
    });
  });

  describe('rule 4: the test imports the oracle', () => {
    it('fails when the test does not exist', () => {
      const r = check({ mutate: dir => writeFiles(dir, { 'tests/foo.test.mjs': null }) });
      assert.match(r.failures.join('\n'), /^4: test tests\/foo\.test\.mjs does not exist/m);
    });

    it('fails when the test imports something else', () => {
      const r = check({ mutate: dir => writeFiles(dir, { 'tests/foo.test.mjs': "import { check } from './oracle/otherOracle.mjs';\n" }) });
      assert.match(r.failures.join('\n'), /^4: tests\/foo\.test\.mjs does not import tests\/oracle\/legacyOracle\.mjs/m);
    });

    it('fails when the oracle is only named in a comment', () => {
      const r = check({ mutate: dir => writeFiles(dir, { 'tests/foo.test.mjs': '// uses ./oracle/legacyOracle.mjs\n' }) });
      assert.match(r.failures.join('\n'), /^4: /m);
    });

    it('passes for a dynamic import and for an import from a deeper folder', () => {
      assert.deepEqual(check({ mutate: dir => writeFiles(dir, { 'tests/foo.test.mjs': "const o = await import('./oracle/legacyOracle.mjs');\n" }) }).failures, []);
      assert.deepEqual(check({ row: { test_file: 'tests/sub/foo.test.mjs' }, mutate: dir => writeFiles(dir, { 'tests/sub/foo.test.mjs': "import { check } from '../oracle/legacyOracle.mjs';\n" }) }).failures, []);
    });
  });

  it('two rows on one symbol count its points once', () => {
    const { dir, rev } = movedRepo({ more: [{ spec_fn: 'foo_inner' }] });
    assert.deepEqual(checkMoved({ repo: dir, rev }).map(r => r.ok), [true, true]);
    const json = JSON.parse(cli(dir, '--check-moved', '--rev', rev, '--json').out);
    assert.deepEqual([json.rows, json.confirmed, json.points], [2, 2, 2], 'Gate.check holds 2 points; two rows do not make 4');
    assert.match(cli(dir, '--check-moved', '--rev', rev).out, /MOVED\.tsv: 2 rows, 2 confirmed, 2 logic points moved/);
  });

  it('rows on two symbols add their points', () => {
    const { dir, rev } = movedRepo({ more: [{ spec_fn: 'foo_inner', source_symbol: 'classify' }] });
    const json = JSON.parse(cli(dir, '--check-moved', '--rev', rev, '--json').out);
    assert.deepEqual([json.rows, json.confirmed, json.points], [2, 2, 3], '2 for Gate.check and 1 for classify');
  });

  it('a failing row moves no points', () => {
    const r = check({ mutate: dir => writeFiles(dir, { 'tests/foo.test.mjs': null }) });
    assert.equal(r.points, 0);
  });

  it('parseMoved wants the header and six columns', () => {
    assert.deepEqual(parseMoved(`${HEADER}\n`), []);
    assert.throws(() => parseMoved(''), /header/);
    assert.throws(() => parseMoved('spec_fn\tsource_file\n'), /header/);
    assert.throws(() => parseMoved(`${HEADER}\na\tb\tc\n`), /3 columns, expected 6/);
    assert.equal(parseMoved(`${HEADER}\na\tb\tc\td\te\tf\n`)[0].test_file, 'f');
  });

  it('symbolPoints finds a function, a method and an arrow bound to a name, and answers null for a missing one', () => {
    const src = "export function f(a) { return a ? 1 : 2; }\nexport const g = (a) => a && a.b;\nclass C { m(a) { if (a > 1) return 1; return 0; } }\n";
    assert.equal(symbolPoints(src, 'x.ts', 'f'), 1);
    assert.equal(symbolPoints(src, 'x.ts', 'g'), 1);
    assert.equal(symbolPoints(src, 'x.ts', 'C.m'), 1);
    assert.equal(symbolPoints(src, 'x.ts', 'm'), null, 'a method needs its class');
    assert.equal(symbolPoints(src, 'x.ts', 'missing'), null);
  });

  it('--check-moved exits 0 when every row passes and 1 when one fails', () => {
    const good = movedRepo();
    const ok = cli(good.dir, '--check-moved', '--rev', good.rev);
    assert.equal(ok.status, 0, ok.out + ok.err);
    assert.match(ok.out, /MOVED\.tsv: 1 rows, 1 confirmed, 2 logic points moved/);
    const bad = movedRepo({ mutate: dir => writeFiles(dir, { 'tests/foo.test.mjs': null }) });
    const fail = cli(bad.dir, '--check-moved', '--rev', bad.rev);
    assert.equal(fail.status, 1);
    assert.match(fail.out, /FAIL foo_pick\n\s+4: test tests\/foo\.test\.mjs does not exist/);
    const json = JSON.parse(cli(good.dir, '--check-moved', '--rev', good.rev, '--json').out);
    assert.deepEqual([json.rows, json.confirmed, json.points], [1, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// shareNumbers: the numbers of the README paragraph, from one place
// ---------------------------------------------------------------------------

describe('shareNumbers', () => {
  it('gives base, now, moved, added, the spec counts and the TypeScript that is left', () => {
    // Base: Gate.check (2 points) and classify (1). Both rows move them. A new function adds 2 points.
    const { dir, sha, rev } = movedRepo({
      more: [{ spec_fn: 'foo_inner', source_symbol: 'classify' }],
      mutate: d => writeFiles(d, { 'src/legacy.ts': `${SOURCE_AFTER}export function wrap(n: number) {\n  return n > 1 && n < 5 ? 1 : 0;\n}\n` }),
    });
    const n = shareNumbers({ repo: dir, rev, baseRev: sha });
    const t = measure({ repo: dir, rev }).total;
    assert.equal(rev, 'WORKTREE');
    assert.equal(n.base, 3);
    assert.equal(n.now, 2, '&& and ?: in wrap');
    assert.equal(n.moved, 3);
    assert.equal(n.added, n.now - (n.base - n.moved));
    assert.equal(n.added, 2);
    assert.equal(n.specs, 1);
    assert.equal(n.specFns, 4, 'foo_pick, foo_inner, foo_hidden and the private foo_private');
    assert.equal(n.t27Lines, SPEC.split('\n').length - 1);
    assert.equal(n.codeLines, t.codeLines);
    assert.deepEqual(n.classes, { type: t.type, data: t.data, text: t.text, boundary: t.boundary, glue: t.glue, logic: t.logic });
  });

  it('refuses a base revision that is not in the repository', () => {
    const { dir, rev } = movedRepo();
    assert.throws(() => shareNumbers({ repo: dir, rev, baseRev: 'deadbee' }), /deadbee/);
  });
});

// ---------------------------------------------------------------------------
// The README paragraph: its numbers are the numbers of the script
// ---------------------------------------------------------------------------

describe('the README share paragraph', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const paragraph = readme.split('\n').find(line => line.startsWith('**t27 share:'));
  const N = '(\\d[\\d,]*)';
  const SHA = '([0-9a-f]{7,40})';
  const PATTERN = new RegExp(
    `^\\*\\*t27 share: (\\d+\\.\\d\\d)% of logic points, measured at ${SHA}\\.\\*\\* ${N} of the ${N} logic points in the TypeScript of \`${SHA}\` moved to ${N} t27 specs ` +
    `\\(${N} functions, ${N} lines\\), compiled to one WebAssembly file\\. The TypeScript now holds ${N} points, ${N} of them new, mostly in the wrappers around the specs\\. ` +
    `(\\d+\\.\\d\\d)% is \`\\(${N} - ${N}\\) / ${N}\`\\. A logic point is one branch, loop, regex literal or text transform, counted by \`node scripts/measure-t27-share\\.mjs\`\\. ` +
    'It counts code shapes, not importance, and its sampled error rate is in `docs/T27_BOUNDARY\\.md`\\. ' +
    `What moved: path, network, write-policy and peer-text rules\\. Everything else, ${N} code lines of it, is still TypeScript\\. ` +
    '\\[docs/T27_BOUNDARY\\.md\\]\\(docs/T27_BOUNDARY\\.md\\) lists what stays native and why\\.$',
  );
  const num = s => Number(s.replace(/,/g, ''));

  it('has the exact wording and every number equals shareNumbers at WORKTREE', T, () => {
    assert.ok(paragraph, 'README.md has no paragraph that starts with "**t27 share:"');
    const m = PATTERN.exec(paragraph);
    assert.ok(m, `the paragraph does not have the wording of the rule:\n${paragraph}`);
    const [, p, codeSha, moved, base, baseSha, specs, specFns, t27Lines, now, added, p2, b1, n1, b2, codeLines] = m;
    const n = shareNumbers({ repo: ROOT, rev: 'WORKTREE' });
    const truncated = (Math.floor(((n.base - n.now) * 10000) / n.base) / 100).toFixed(2);
    assert.equal(p, truncated, 'p is (B - N) / B in percent, truncated to two decimals, never rounded up');
    assert.equal(p2, truncated);
    assert.equal(num(moved), n.moved);
    assert.equal(num(base), n.base);
    assert.equal(num(specs), n.specs);
    assert.equal(num(specFns), n.specFns);
    assert.equal(num(t27Lines), n.t27Lines);
    assert.equal(num(now), n.now);
    assert.equal(num(added), n.added);
    assert.deepEqual([num(b1), num(n1), num(b2)], [n.base, n.now, n.base]);
    assert.equal(num(codeLines), n.codeLines);
    assert.equal(baseSha, BASE_REV, 'the base of the share is the revision the script measures against');
    assert.equal(n.added, n.now - (n.base - n.moved));
    assert.notEqual(resolveRev(ROOT, codeSha), null, `the commit ${codeSha} the share was measured at is not in this repository`);
  });

  it('claims nothing the share does not show', () => {
    assert.doesNotMatch(readme, /100% t27|written entirely in t27|all logic/i);
  });
});
