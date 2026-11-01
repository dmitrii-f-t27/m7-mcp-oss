// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * The t27 toolchain and the loader of wasm/m7_rules.wasm (specs/, src/rules/, scripts/check-rules-manifest.mjs,
 * scripts/make-oracle.mjs).
 *
 * What is proved here, without the toolchain:
 * - the wasm has no imports and exactly the exports of specs/exports.txt, memory and _initialize;
 * - the manifest and WASM_SHA256 match the files, and a flipped byte in a spec, a generated header or the wasm
 *   is found;
 * - bytes_rules answers like the TypeScript it mirrors for all 256 bytes;
 * - the loader fails closed: a trap, a refused argument, a garbage file, a missing file or a wrong hash end in
 *   the refusing value, in `Rules unavailable` on stderr and exit 1 at start-up, and a failed load stays failed;
 * - the lint rules, the manifest writer and make-oracle do what they say.
 * With T27C and ZIG set it also runs `specs/generate.sh --check` (the wasm is what the specs compile to);
 * without them that test is skipped.
 *
 * Everything is written under the system temp directory, never into the repository.
 *
 * Run: npm run build && node --test --test-force-exit tests/rulesWasm.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { extractSymbols, makeOracle } from '../scripts/make-oracle.mjs';
import { manifestFiles, verifyManifest, writeManifest } from '../scripts/check-rules-manifest.mjs';
import { lintSpec, lintTree } from '../specs/lint.mjs';
import { ROOT, isolatedEnv, makeProject, removeProject } from './helpers/deepScanHarness.mjs';

const rules = await import('../dist/rules/wasm.js');
const marshal = await import('../dist/rules/marshal.js');

const T = { timeout: 120_000 };
const made = [];
after(() => {
  rules.setRulesExportsForTests(null);
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tempDir = prefix => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(d);
  return d;
};

const WASM = path.join(ROOT, 'wasm', 'm7_rules.wasm');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');
const names = rel => read(rel).split('\n').flatMap(l => l.replace(/#.*/, '').split(/\s+/)).filter(Boolean);

// ---------------------------------------------------------------------------
// The wasm file
// ---------------------------------------------------------------------------

describe('wasm/m7_rules.wasm', () => {
  const mod = new WebAssembly.Module(readFileSync(WASM));

  it('has no imports', () => {
    assert.deepEqual(WebAssembly.Module.imports(mod), []);
  });

  it('exports exactly the names of specs/exports.txt, memory and _initialize', () => {
    const have = WebAssembly.Module.exports(mod).map(e => e.name).sort();
    assert.deepEqual(have, [...names('specs/exports.txt'), 'memory', '_initialize'].sort());
  });

  it('every name of specs/exports.txt is a pub fn of a spec in specs/ORDER or a function of the wrapper', () => {
    const pub = names('specs/ORDER').flatMap(s => [...read(`specs/${s}.t27`).matchAll(/^pub fn ([A-Za-z_][A-Za-z0-9_]*)\(/gm)].map(m => m[1]));
    const wrapper = [...read('specs/wasm/m7_rules_wasm.c').matchAll(/^uint8_t \*([a-z_0-9]+)\(void\) \{/gm)].map(m => m[1]);
    for (const e of names('specs/exports.txt')) assert.ok(pub.includes(e) || wrapper.includes(e), `${e} is neither a pub fn nor a wrapper function`);
  });

  it('WASM_SHA256 in generated/constants.ts is the SHA-256 of the file', () => {
    const m = /export const WASM_SHA256 = "([0-9a-f]{64})";/.exec(read('src/rules/generated/constants.ts'));
    assert.ok(m, 'WASM_SHA256 is missing');
    assert.equal(m[1], createHash('sha256').update(readFileSync(WASM)).digest('hex'));
  });

  it('the generated constants match the #define numbers of the generated headers', () => {
    const defs = names('specs/ORDER').flatMap(s => [...read(`specs/generated/${s}.h`).matchAll(/^#define ([A-Z][A-Z0-9_]*) (-?\d+)$/gm)].map(m => `export const ${m[1]} = ${m[2]};`));
    const ts = read('src/rules/generated/constants.ts').split('\n').filter(l => l.startsWith('export const ') && !l.includes('WASM_SHA256'));
    assert.deepEqual(ts, defs);
  });

  it('every generated header starts with the change notice', () => {
    for (const s of names('specs/ORDER')) {
      assert.match(read(`specs/generated/${s}.h`).split('\n')[0], /^\/\/ Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP\. Apache-2\.0 \(see NOTICE\)\.$/);
    }
  });

  it('specs/T27C_PIN names the commit, the t27c version and the zig version', () => {
    const line = read('specs/T27C_PIN').split('\n').find(l => !l.startsWith('#') && l.trim());
    assert.match(line, /^[0-9a-f]{9} t27c-0\.5\.1 zig-0\.15\.2$/);
  });
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

function copyRules(dest) {
  cpSync(path.join(ROOT, 'specs'), path.join(dest, 'specs'), { recursive: true });
  cpSync(path.join(ROOT, 'wasm'), path.join(dest, 'wasm'), { recursive: true });
  mkdirSync(path.join(dest, 'src', 'rules', 'generated'), { recursive: true });
  cpSync(path.join(ROOT, 'src', 'rules', 'generated', 'constants.ts'), path.join(dest, 'src', 'rules', 'generated', 'constants.ts'));
}

function flipByte(file) {
  const bytes = readFileSync(file);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  writeFileSync(file, bytes);
}

describe('specs/MANIFEST.sha256', () => {
  it('verifyManifest passes on the tree', () => {
    const r = verifyManifest(ROOT);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });

  it('covers the specs, the build inputs, the generated files, the wrapper, the wasm and constants.ts', () => {
    const files = manifestFiles(ROOT);
    for (const f of ['specs/ORDER', 'specs/T27C_PIN', 'specs/exports.txt', 'specs/lint.mjs', 'specs/generate.sh', 'specs/wasm/m7_rules_wasm.c', 'wasm/m7_rules.wasm', 'src/rules/generated/constants.ts']) {
      assert.ok(files.includes(f), `${f} is not covered`);
    }
    for (const s of names('specs/ORDER')) assert.ok(files.includes(`specs/${s}.t27`) && files.includes(`specs/generated/${s}.h`), `${s} is not covered`);
  });

  for (const [what, rel] of [['a .t27 spec', 'specs/bytes_rules.t27'], ['a generated .h', 'specs/generated/bytes_rules.h'], ['the .wasm', 'wasm/m7_rules.wasm'], ['constants.ts', 'src/rules/generated/constants.ts'], ['specs/ORDER', 'specs/ORDER']]) {
    it(`verifyManifest fails after one byte of ${what} flips, in a temp copy`, () => {
      const dir = tempDir('rules-manifest-');
      copyRules(dir);
      assert.equal(verifyManifest(dir).ok, true, 'the copy is clean before the flip');
      flipByte(path.join(dir, rel));
      const r = verifyManifest(dir);
      assert.equal(r.ok, false);
      assert.ok(r.problems.some(p => p.startsWith(`${rel}: SHA-256 differs`)), r.problems.join('\n'));
    });
  }

  it('verifyManifest fails for a missing file, an unlisted file and a missing manifest', () => {
    const dir = tempDir('rules-manifest-');
    copyRules(dir);
    rmSync(path.join(dir, 'wasm', 'm7_rules.wasm'));
    assert.match(verifyManifest(dir).problems.join('\n'), /wasm\/m7_rules\.wasm: listed in the manifest but missing/);
    copyRules(dir);
    writeFileSync(path.join(dir, 'specs', 'generated', 'extra.h'), '/* extra */\n');
    assert.match(verifyManifest(dir).problems.join('\n'), /specs\/generated\/extra\.h: exists but is not in the manifest/);
    rmSync(path.join(dir, 'specs', 'MANIFEST.sha256'));
    assert.equal(verifyManifest(dir).ok, false);
  });

  it('writeManifest writes what verifyManifest accepts, and leaves out dot files', () => {
    const dir = tempDir('rules-manifest-');
    copyRules(dir);
    writeFileSync(path.join(dir, 'specs', 'generated', '.DS_Store'), 'x');
    writeFileSync(path.join(dir, 'specs', 'bytes_rules.t27'), `${read('specs/bytes_rules.t27')}\n; changed\n`);
    assert.equal(verifyManifest(dir).ok, false);
    const text = writeManifest(dir);
    assert.equal(verifyManifest(dir).ok, true);
    assert.ok(!text.includes('.DS_Store'));
    assert.equal(text.split('\n')[0], '# Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).');
  });
});

// ---------------------------------------------------------------------------
// bytes_rules in the wasm against the TypeScript it mirrors
// ---------------------------------------------------------------------------

// pathGuard.ts: isSeparator and foldAscii, written out here as the reference.
const refFold = c => (c >= 65 && c <= 90 ? c + 32 : c);
const refSep = (c, win) => c === 47 || (win && c === 92);
const refCont = c => c >= 0x80 && c <= 0xbf;

describe('bytes_rules', () => {
  it('by_fold_ascii, by_is_sep and by_is_cont equal the reference for every byte', () => {
    const bad = [];
    for (let b = 0; b < 256; b++) {
      const got = rules.callRules(x => [x.by_fold_ascii(b), x.by_is_sep(b, 0), x.by_is_sep(b, 1), x.by_is_cont(b)], null);
      const want = [refFold(b), refSep(b, false) ? 1 : 0, refSep(b, true) ? 1 : 0, refCont(b) ? 1 : 0];
      if (got === null || got.join() !== want.join()) bad.push(`${b}: got ${got}, want ${want}`);
    }
    assert.deepEqual(bad, []);
  });

  it('after a reset the loader reads the file again and the known answers hold', () => {
    rules.setRulesExportsForTests(null);
    assert.equal(rules.callRules(x => x.by_fold_ascii(65), -1), 97);
  });
});

// ---------------------------------------------------------------------------
// The loader fails closed
// ---------------------------------------------------------------------------

const stub = overrides => ({
  memory: new WebAssembly.Memory({ initial: 1 }),
  by_fold_ascii: b => b,
  by_is_sep: () => 0,
  by_is_cont: () => 0,
  ...overrides,
});

describe('callRules and callRulesOrThrow', () => {
  it('a throwing stub makes callRules return onFail, and the next call gets a fresh instance', () => {
    rules.setRulesExportsForTests(stub({ by_fold_ascii() { throw new Error('trap'); } }));
    const seen = [];
    assert.equal(rules.callRules(x => { seen.push(x); return x.by_fold_ascii(65); }, -1), -1);
    assert.equal(rules.callRules(x => { seen.push(x); return x.by_fold_ascii(65); }, -1), 97, 'a fresh instance from the file answers');
    assert.equal(rules.callRules(x => { seen.push(x); return 1; }, -1), 1);
    assert.notEqual(seen[0], seen[1], 'the stub was dropped');
    assert.equal(seen[1], seen[2], 'a good instance is kept');
  });

  it('the call that trapped is not retried', () => {
    let calls = 0;
    assert.equal(rules.callRules(() => { calls++; throw new Error('trap'); }, 'refused'), 'refused');
    assert.equal(calls, 1);
  });

  it('a real trap in the wasm, an unreachable, is a throw too', () => {
    // Division is not in bytes_rules, so make the trap in a hand-written module: (func unreachable).
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 5, 1, 3, 0, 0, 11]);
    const f = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.f;
    assert.throws(() => f(), /unreachable/i);
    assert.equal(rules.callRules(() => f(), 'refused'), 'refused');
    assert.equal(rules.callRules(x => x.by_fold_ascii(66), -1), 98, 'the rules still answer afterwards');
  });

  it('a refused argument inside callRules returns onFail', () => {
    assert.equal(rules.callRules(x => x.by_fold_ascii(marshal.checkU8(300)), -1), -1);
    assert.equal(rules.callRules(x => x.by_is_sep(46, marshal.checkBool(2)), -1), -1);
    assert.equal(rules.callRules(x => x.by_fold_ascii(marshal.checkU8(65)), -1), 97);
  });

  it('callRulesOrThrow throws RulesUnavailableError when the call throws, and works again after', () => {
    assert.throws(() => rules.callRulesOrThrow(() => { throw new Error('trap'); }), rules.RulesUnavailableError);
    assert.equal(rules.callRulesOrThrow(x => x.by_fold_ascii(67)), 99);
  });

  it('memory.buffer is read again on every call', () => {
    rules.callRules(x => { x.memory.grow(1); return 0; }, -1);
    assert.equal(rules.callRules((x, mem) => mem.length === x.memory.buffer.byteLength, false), true);
    assert.equal(rules.callRules((x, mem) => mem.buffer === x.memory.buffer, false), true);
  });
});

// ---------------------------------------------------------------------------
// A bad install: garbage, missing, wrong hash
// ---------------------------------------------------------------------------

/** A copy of dist/ with a linked node_modules, so `node dist/index.js` runs from it. wasm/ is filled by the caller. */
let installCopy = null;
function makeInstall(wasmBytes) {
  if (!installCopy) {
    installCopy = tempDir('rules-install-');
    cpSync(path.join(ROOT, 'dist'), path.join(installCopy, 'dist'), { recursive: true });
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(installCopy, 'node_modules'), 'dir');
    cpSync(path.join(ROOT, 'package.json'), path.join(installCopy, 'package.json'));
  }
  rmSync(path.join(installCopy, 'wasm'), { recursive: true, force: true });
  if (wasmBytes !== null) {
    mkdirSync(path.join(installCopy, 'wasm'));
    writeFileSync(path.join(installCopy, 'wasm', 'm7_rules.wasm'), wasmBytes);
  }
  return installCopy;
}

const EMPTY_MODULE = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

describe('a bad install stops the server and the loader stays failed', () => {
  const cases = [
    ['garbage bytes', () => Buffer.from('this is not a wasm file, it is just text\n')],
    ['a missing file', () => null],
    ['a valid wasm module with another hash', () => EMPTY_MODULE],
    ['the right file with one byte flipped', () => { const b = Buffer.from(readFileSync(WASM)); b[b.length - 1] ^= 1; return b; }],
  ];
  for (const [what, bytes] of cases) {
    it(`${what}: the server exits non-zero with "Rules unavailable" on stderr`, T, async () => {
      const dir = makeInstall(bytes());
      const project = await makeProject('rules-bad-');
      try {
        const run = spawnSync(process.execPath, [path.join(dir, 'dist', 'index.js')], {
          cwd: project, env: isolatedEnv(project), encoding: 'utf8', timeout: 90_000, input: '',
        });
        assert.notEqual(run.status, 0, `exit ${run.status}, stderr: ${run.stderr}`);
        assert.match(run.stderr, /\[M7\] Rules unavailable: /);
      } finally {
        await removeProject(project);
      }
    });

    it(`${what}: assertRulesLoaded throws each time, callRules returns onFail, callRulesOrThrow throws`, T, () => {
      const dir = makeInstall(bytes());
      const url = pathToFileURL(path.join(dir, 'dist', 'rules', 'wasm.js')).href;
      const script = `
        import { assertRulesLoaded, callRules, callRulesOrThrow, RulesUnavailableError } from ${JSON.stringify(url)};
        const out = {};
        for (const i of [0, 1]) {
          try { assertRulesLoaded(); out['assert' + i] = 'ok'; } catch (e) { out['assert' + i] = e instanceof RulesUnavailableError ? 'unavailable' : String(e); }
        }
        out.call = callRules(() => 1, 'refused');
        try { callRulesOrThrow(() => 1); out.orThrow = 'ok'; } catch (e) { out.orThrow = e.name; }
        console.log(JSON.stringify(out));`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), { assert0: 'unavailable', assert1: 'unavailable', call: 'refused', orThrow: 'RulesUnavailableError' });
    });
  }

  it('control: the same copy with the real wasm loads', T, () => {
    const dir = makeInstall(readFileSync(WASM));
    const url = pathToFileURL(path.join(dir, 'dist', 'rules', 'wasm.js')).href;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import { assertRulesLoaded, callRules } from ${JSON.stringify(url)}; assertRulesLoaded(); console.log(callRules(x => x.by_fold_ascii(65), -1));`], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '97');
  });
});

// ---------------------------------------------------------------------------
// Static rules
// ---------------------------------------------------------------------------

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('what src/rules and the package must not contain', () => {
  const sources = filesUnder(path.join(ROOT, 'src', 'rules')).filter(f => f.endsWith('.ts'));

  it('src/rules has no process.env', () => {
    assert.ok(sources.length >= 3);
    for (const f of sources) assert.doesNotMatch(readFileSync(f, 'utf8'), /process\.env|import\.meta\.env/, f);
  });

  it('src/rules has no await: a buffer is filled and read in one synchronous step', () => {
    for (const f of sources) assert.doesNotMatch(readFileSync(f, 'utf8'), /\bawait\b/, f);
  });

  it('the wasm path is the fixed URL ../../wasm/m7_rules.wasm and nothing else names a wasm file', () => {
    const text = readFileSync(path.join(ROOT, 'src', 'rules', 'wasm.ts'), 'utf8');
    assert.equal(text.match(/new URL\('\.\.\/\.\.\/wasm\/m7_rules\.wasm'/g)?.length, 1);
    assert.deepEqual([...text.matchAll(/['"`][^'"`\n]*\.wasm['"`]/g)].map(m => m[0]), ["'../../wasm/m7_rules.wasm'"]);
  });

  it('package.json scripts mention neither t27c nor zig, and npm run build is tsc only', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const [name, cmd] of Object.entries(pkg.scripts)) assert.doesNotMatch(cmd, /t27c|zig/i, name);
    assert.equal(pkg.scripts.build, 'tsc');
  });

  it('package.json files lists wasm, specs, NOTICE and SECURITY.md', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const f of ['wasm/**/*', 'specs/**/*', 'NOTICE', 'SECURITY.md']) assert.ok(pkg.files.includes(f), f);
  });

  it('.gitattributes marks *.wasm binary and the generated headers as generated', () => {
    const lines = read('.gitattributes').split('\n');
    assert.ok(lines.includes('*.wasm binary'));
    assert.ok(lines.includes('specs/generated/*.h linguist-generated=true'));
  });
});

// ---------------------------------------------------------------------------
// marshal.ts
// ---------------------------------------------------------------------------

describe('marshal', () => {
  it('putText writes UTF-8 and returns the byte count, or -1 and never cuts', () => {
    const mem = new Uint8Array(16);
    assert.equal(marshal.putText(mem, 2, 8, 'abc'), 3);
    assert.deepEqual([...mem.subarray(2, 5)], [97, 98, 99]);
    assert.equal(marshal.putText(mem, 0, 4, 'abcd'), 4);
    assert.equal(marshal.putText(mem, 0, 4, 'abcde'), -1, 'one byte too many');
    assert.equal(marshal.putText(mem, 0, 4, 'abcé'), -1, 'a two-byte character does not fit in the last byte');
    assert.equal(marshal.putText(mem, 0, 5, 'abcé'), 5);
    assert.equal(marshal.putText(mem, 0, 4, '\u{1F600}'), 4, 'an astral character is four bytes');
    assert.equal(marshal.putText(mem, 0, 3, '\u{1F600}'), -1);
    assert.equal(marshal.putText(mem, 14, 8, 'a'), -1, 'past the end of memory');
    assert.equal(marshal.putText(mem, -1, 4, 'a'), -1);
    assert.equal(marshal.putText(mem, 0, 4, ''), 0);
  });

  it('isWellFormedText and toWellFormedText find lone surrogates', () => {
    assert.equal(marshal.isWellFormedText('abc\u{1F600}'), true);
    assert.equal(marshal.isWellFormedText('a\ud800b'), false);
    assert.equal(marshal.isWellFormedText('\udc00'), false);
    assert.equal(marshal.toWellFormedText('a\ud800b'), 'a�b');
  });

  it('asBytes encodes a string and passes a Buffer through', () => {
    assert.deepEqual([...marshal.asBytes('aé')], [97, 0xc3, 0xa9]);
    const buf = Buffer.from([1, 2, 3]);
    assert.equal(marshal.asBytes(buf), buf);
  });

  it('checkBool, checkU8, checkI32 and checkI64 accept the range and refuse everything else', () => {
    assert.equal(marshal.checkBool(0), 0);
    assert.equal(marshal.checkBool(1), 1);
    for (const v of [2, -1, 256, NaN, 0.5, '1', true, null, undefined]) assert.throws(() => marshal.checkBool(v), RangeError, String(v));
    assert.equal(marshal.checkU8(0), 0);
    assert.equal(marshal.checkU8(255), 255);
    for (const v of [-1, 256, 300, 1.5, NaN, Infinity, '7']) assert.throws(() => marshal.checkU8(v), RangeError, String(v));
    assert.equal(marshal.checkI32(-2147483648), -2147483648);
    assert.equal(marshal.checkI32(2147483647), 2147483647);
    for (const v of [-2147483649, 2147483648, 1.9, NaN, '7', undefined]) assert.throws(() => marshal.checkI32(v), RangeError, String(v));
    assert.equal(marshal.checkI64(2n ** 63n - 1n), 2n ** 63n - 1n);
    assert.equal(marshal.checkI64(-(2n ** 63n)), -(2n ** 63n));
    for (const v of [2n ** 63n, -(2n ** 63n) - 1n, 2n ** 64n + 7n, 5, '5']) assert.throws(() => marshal.checkI64(v), RangeError, String(v));
  });

  it('fromBool, u32Result and u64Result convert results', () => {
    assert.equal(marshal.fromBool(1), true);
    assert.equal(marshal.fromBool(0), false);
    assert.throws(() => marshal.fromBool(2), RangeError);
    assert.equal(marshal.u32Result(-1), 4294967295);
    assert.equal(marshal.u64Result(-1n), 2n ** 64n - 1n);
  });
});

// ---------------------------------------------------------------------------
// specs/lint.mjs
// ---------------------------------------------------------------------------

const rulesOf = (text, exported = []) => lintSpec(text, { exported: new Set(exported) }).map(p => p.rule);

describe('specs/lint.mjs', () => {
  it('the specs of the tree are clean', () => {
    const { problems, specs } = lintTree(ROOT);
    assert.deepEqual(problems, []);
    assert.ok(specs >= 1);
  });

  it('a clean spec with comments, a guarded divisor and a guarded export gives nothing', () => {
    const good = [
      '// notice',
      '; comment with for, not, use and assert and a "string"',
      'module Good;',
      'pub const MAX : i64 = 16;',
      'pub fn g_take(buf: [16]u8, len: i64, d: i64) -> i64 {',
      '    if (len < 0 or len > MAX) { return -1; }',
      '    // for not use assert',
      '    var x : i64 = 8 / 2;',
      '    if (d != 0) { x = x / d; } // guarded',
      '    return x % MAX;',
      '}',
      'test g_take_ok {',
      '    var t : [16]u8 = [0; 16];',
      '    assert g_take(t, 0, 1) == 4;',
      '}',
    ].join('\n');
    assert.deepEqual(rulesOf(good, ['g_take']), []);
  });

  const bad = {
    'string-non-ascii': 'module A;\nfn f() -> i64 {\n    var s : [8]u8 = "café";\n    return 0;\n}\n',
    'string-non-ascii (\\x)': 'module A;\nfn f() -> i64 {\n    var s : [8]u8 = "a\\x41";\n    return 0;\n}\n',
    use: 'module A;\nuse other;\n',
    'assert-outside-test': 'module A;\nfn f(a: i64) -> i64 {\n    assert a > 0;\n    return a;\n}\n',
    for: 'module A;\nfn f(n: i64) -> i64 {\n    for i in 0..n { }\n    return 0;\n}\n',
    not: 'module A;\nfn f(a: bool) -> bool {\n    return not a;\n}\n',
    'while-true': 'module A;\nfn f() -> i64 {\n    while (true) { return 1; }\n    return 0;\n}\n',
    'unguarded-divisor': 'module A;\nfn f(a: i64, b: i64) -> i64 {\n    return a / b;\n}\n',
    'unguarded-divisor (%)': 'module A;\nfn f(a: i64, b: i64) -> i64 {\n    return a % (b + 1);\n}\n',
    'big-local-array': 'module A;\nfn f() -> i64 {\n    var t : [65537]u8 = [0; 65537];\n    return 0;\n}\n',
    'big-local-array (i64)': 'module A;\nfn f() -> i64 {\n    var t : [8193]i64 = [0; 8193];\n    return 0;\n}\n',
    'big-local-array (unknown size)': 'module A;\nfn f(n: i64) -> i64 {\n    var t : [n]u8 = [0; 8];\n    return 0;\n}\n',
  };
  for (const [name, text] of Object.entries(bad)) {
    it(`flags ${name}`, () => {
      const want = name.replace(/ \(.*\)$/, '');
      assert.ok(rulesOf(text).includes(want), `${want} not reported: ${JSON.stringify(lintSpec(text))}`);
    });
  }

  it('does not flag a local array of exactly 64 KiB, a global array of any size, or a divisor that is a constant', () => {
    assert.deepEqual(rulesOf('module A;\nvar G : [4194304]u8 = [0; 4194304];\npub const K : i64 = 3;\nfn f(a: i64) -> i64 {\n    var t : [65536]u8 = [0; 65536];\n    return a / K;\n}\n'), []);
  });

  it('flags a struct in an exported signature, and not in a private one', () => {
    const text = 'module A;\npub struct Slot { a: i64, }\npub fn s_make(a: i64) -> Slot {\n    var s : Slot = Slot { a: a };\n    return s;\n}\n';
    assert.ok(rulesOf(text, ['s_make']).includes('struct-in-export'));
    assert.ok(!rulesOf(text, []).includes('struct-in-export'));
  });

  it('flags an exported function with an array and a len whose first statement is not a length check', () => {
    const head = 'module A;\npub const MAX : i64 = 16;\n';
    const noCheck = `${head}pub fn e_f(buf: [16]u8, len: i64) -> i64 {\n    var x : i64 = 0;\n    if (len < 0) { return -1; }\n    return x;\n}\n`;
    assert.ok(rulesOf(noCheck, ['e_f']).includes('missing-length-check'));
    const wrongName = `${head}pub fn e_f(buf: [16]u8, len: i64) -> i64 {\n    if (MAX < 0) { return -1; }\n    return 0;\n}\n`;
    assert.ok(rulesOf(wrongName, ['e_f']).includes('missing-length-check'));
    const oneOfTwo = `${head}pub fn e_f(a: [16]u8, a_len: i64, b: [16]u8, b_len: i64) -> i64 {\n    if (a_len < 0 or a_len > MAX) { return -1; }\n    return 0;\n}\n`;
    assert.ok(rulesOf(oneOfTwo, ['e_f']).includes('missing-length-check'), 'b_len is not compared');
    const both = `${head}pub fn e_f(a: [16]u8, a_len: i64, b: [16]u8, b_len: i64) -> i64 {\n    if (a_len < 0 or a_len > MAX or b_len < 0 or b_len > MAX) { return -1; }\n    return 0;\n}\n`;
    assert.deepEqual(rulesOf(both, ['e_f']), []);
    assert.ok(!rulesOf(noCheck, []).includes('missing-length-check'), 'a function that is not exported is not checked');
  });

  it('lintTree checks ORDER against the files and exports.txt against the pub fns', () => {
    const dir = tempDir('rules-lint-');
    mkdirSync(path.join(dir, 'specs'));
    writeFileSync(path.join(dir, 'specs', 'a.t27'), 'module A;\npub fn a_one(x: u8) -> u8 {\n    return x;\n}\n');
    writeFileSync(path.join(dir, 'specs', 'ORDER'), 'a b\n');
    writeFileSync(path.join(dir, 'specs', 'exports.txt'), 'a_one a_two # comment\n');
    const text = lintTree(dir).problems.join('\n');
    assert.match(text, /specs\/ORDER:/);
    assert.match(text, /a_two is not a pub fn of any spec nor defined in a wrapper/);
    assert.doesNotMatch(text, /a_one is not/);
    mkdirSync(path.join(dir, 'specs', 'wasm'));
    writeFileSync(path.join(dir, 'specs', 'wasm', 'w.c'), 'uint8_t *a_two(void) { return 0; }\n');
    assert.doesNotMatch(lintTree(dir).problems.join('\n'), /a_two/, 'a function that a wrapper defines can be exported');
  });

  it('the CLI exits 1 on a problem and 0 on a clean tree', () => {
    const lint = path.join(ROOT, 'specs', 'lint.mjs');
    assert.equal(spawnSync(process.execPath, [lint, ROOT], { encoding: 'utf8' }).status, 0);
    const dir = tempDir('rules-lint-');
    mkdirSync(path.join(dir, 'specs'));
    writeFileSync(path.join(dir, 'specs', 'a.t27'), 'module A;\nuse b;\n');
    writeFileSync(path.join(dir, 'specs', 'ORDER'), 'a\n');
    const run = spawnSync(process.execPath, [lint, dir], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /\[use\]/);
  });
});

// ---------------------------------------------------------------------------
// scripts/make-oracle.mjs
// ---------------------------------------------------------------------------

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

const LEGACY = [
  "import { readFileSync } from 'node:fs';",
  "import { heavy } from './heavy.js';",
  'const GAP = 32;',
  'interface Opts { win: boolean }',
  'function inner(c: number): number { return c + GAP; }',
  'export function fold(c: number, o?: Opts): number { return c >= 65 && c <= 90 ? inner(c) : c; }',
  'export function usesHeavy(): number { return heavy(); }',
  "export function readIt(p: string): string { return readFileSync(p, 'utf8'); }",
  'export function pure(a: number): number { return a + 1; }',
  '',
].join('\n');

describe('scripts/make-oracle.mjs', () => {
  const repo = tempDir('rules-oracle-');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src', 'legacy.ts'), LEGACY);
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const rev = git(repo, 'rev-parse', '--short=9', 'HEAD');
  git(repo, 'rm', '-q', 'src/legacy.ts');
  git(repo, 'commit', '-q', '-m', 'gone');

  it('line 1 is the notice and line 2 names the source and the commit', () => {
    const text = makeOracle({ repo, rev, src: 'src/legacy.ts', symbols: ['pure'] });
    const [one, two] = text.split('\n');
    assert.equal(one, '// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).');
    assert.equal(two, `// Oracle: src/legacy.ts at ${rev}. Test use only.`);
  });

  it('reads the commit, not the working tree (the file is deleted at HEAD)', () => {
    assert.match(makeOracle({ repo, rev, src: 'src/legacy.ts', symbols: ['pure'] }), /function pure/);
  });

  it('--symbols keeps the symbols, what they use and the imports they use, and drops the rest', () => {
    const text = makeOracle({ repo, rev, src: 'src/legacy.ts', symbols: ['fold'] });
    assert.match(text, /export function fold/);
    assert.match(text, /const GAP = 32/);
    assert.match(text, /function inner/);
    assert.doesNotMatch(text, /usesHeavy|heavy|readIt|readFileSync|pure/);
    assert.doesNotMatch(text, /interface|: number|: boolean/, 'types are erased');
  });

  it('an oracle made with --symbols runs', async () => {
    const out = path.join(tempDir('rules-oracle-out-'), 'legacy.mjs');
    writeFileSync(out, makeOracle({ repo, rev, src: 'src/legacy.ts', symbols: ['fold'] }));
    const mod = await import(pathToFileURL(out).href);
    assert.deepEqual([mod.fold(65), mod.fold(97), mod.fold(90)], [97, 97, 122]);
  });

  it('a symbol that is not exported in the source is exported in the oracle', () => {
    const text = extractSymbols('function a() { return 1; }\nexport function b() { return a(); }\n', 'x.ts', ['a']);
    assert.match(text, /export function a/);
    assert.doesNotMatch(text, /function b/);
  });

  it('keeps an import that a kept declaration uses', () => {
    const text = makeOracle({ repo, rev, src: 'src/legacy.ts', symbols: ['readIt'] });
    assert.match(text, /import \{ readFileSync \} from 'node:fs'/);
  });

  it('a needed relative import is an error, and so is an unknown symbol', () => {
    assert.throws(() => makeOracle({ repo, rev, src: 'src/legacy.ts', symbols: ['usesHeavy'] }), /relative import/);
    assert.throws(() => makeOracle({ repo, rev, src: 'src/legacy.ts', symbols: ['nope'] }), /"nope" is not a top-level/);
  });

  it('without --symbols the whole file is transpiled', () => {
    const text = makeOracle({ repo, rev, src: 'src/legacy.ts' });
    assert.match(text, /export function usesHeavy/);
    assert.match(text, /import \{ heavy \} from '\.\/heavy\.js'/);
  });

  it('a rev that is not hex is refused', () => {
    assert.throws(() => makeOracle({ repo, rev: 'main', src: 'src/legacy.ts' }), /hex/);
  });

  it('the CLI writes the file', () => {
    const out = path.join(tempDir('rules-oracle-out-'), 'sub', 'o.mjs');
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'make-oracle.mjs'), rev, 'src/legacy.ts', out, '--symbols', 'pure', '--repo', repo], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(out, 'utf8'), /export function pure/);
    const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'make-oracle.mjs'), rev, 'src/legacy.ts'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
  });
});

// ---------------------------------------------------------------------------
// specs/generate.sh --check (needs the toolchain)
// ---------------------------------------------------------------------------

describe('specs/generate.sh', () => {
  it('refuses to run without T27C, ZIG and CC (exit 2)', T, () => {
    const env = { ...process.env };
    delete env.T27C;
    delete env.ZIG;
    delete env.CC;
    const run = spawnSync('bash', [path.join(ROOT, 'specs', 'generate.sh'), '--check'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /T27C is not set/);
    const bad = spawnSync('bash', [path.join(ROOT, 'specs', 'generate.sh'), '--no-such-option'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(bad.status, 2);
  });

  it('--check is clean: the generated files are what the specs produce', { timeout: 600_000 }, t => {
    if (!process.env.T27C || !process.env.ZIG) {
      t.skip('T27C and ZIG are not set; the final checks run this test with the toolchain');
      return;
    }
    const run = spawnSync('bash', [path.join(ROOT, 'specs', 'generate.sh'), '--check'], {
      cwd: ROOT, env: { ...process.env, CC: process.env.CC || 'cc' }, encoding: 'utf8', timeout: 540_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /generate\.sh --check: clean/);
  });
});
