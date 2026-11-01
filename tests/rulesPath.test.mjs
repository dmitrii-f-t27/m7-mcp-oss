// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * The path rules (specs/path_rules.t27, specs/path_tables.t27, specs/bytes_rules.t27) against the
 * TypeScript they replace.
 *
 * The oracles are the old code, transpiled at commit c41f8ce by scripts/make-oracle.mjs:
 *   tests/oracles/pathGuardLegacy.mjs     src/core/security/pathGuard.ts
 *   tests/oracles/projectPathLegacy.mjs   src/core/utils/projectPath.ts
 * Every test compares the new public functions (dist/core/security/pathGuard.js,
 * dist/core/utils/projectPath.js) with the oracle on the same input. For input inside the new limits they
 * must give the same answer. The cases below the heading "New behaviour" are the only ones where they may
 * differ, and each says why:
 *   - a text over 4096 bytes (a verdict: over 16384 bytes after folding) is refused, never cut;
 *   - a lone surrogate cannot be written as UTF-8 and is refused;
 *   - a failing backend gives the refusing value of the rule.
 *
 * Seed: the random cases use M7_RULES_SEED (default 27). Every failure message starts with the seed and
 * the case number, so a failure can be repeated: M7_RULES_SEED=<seed> node --test tests/rulesPath.test.mjs
 *
 * Run: npm run build && node --test --test-force-exit tests/rulesPath.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ROOT } from './helpers/deepScanHarness.mjs';
import * as legacy from './oracles/pathGuardLegacy.mjs';
import * as legacyPP from './oracles/projectPathLegacy.mjs';

const guard = await import('../dist/core/security/pathGuard.js');
const pp = await import('../dist/core/utils/projectPath.js');
const rules = await import('../dist/rules/wasm.js');

const SEED = Number(process.env.M7_RULES_SEED ?? 27);
const N_PATHS = 200_000;
const T = { timeout: 110_000 };
const enc = new TextEncoder();
const bytes = s => enc.encode(s).length;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
const below = (rnd, n) => Math.floor(rnd() * n);

const counts = {};
const count = (name, n = 1) => { counts[name] = (counts[name] ?? 0) + n; };
after(() => {
  rules.setRulesExportsForTests(null);
  console.log(`rulesPath: seed ${SEED}; cases compared with the oracle: ${JSON.stringify(counts)}`);
});

/** Compare `got` and `want`; the message names the seed, the case and the input. */
function same(label, i, input, got, want) {
  if (got !== want) {
    assert.fail(`[seed ${SEED}] ${label} case ${i}: input ${JSON.stringify(input)}\n  new:    ${JSON.stringify(got)}\n  oracle: ${JSON.stringify(want)}`);
  }
}

/** Run `fn` with process.platform set to `platform`. */
function onPlatform(platform, fn) {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', saved);
  }
}

/** A backend whose functions all throw, except what `override` replaces. memory and the buffer addresses are the real ones. */
function brokenRules(override = {}) {
  const real = rules.callRules(x => x, null);
  assert.ok(real, 'the real rules load');
  return new Proxy({}, {
    get: (_, key) => {
      if (key in override) return override[key];
      if (key === 'memory') return real.memory;
      if (typeof key === 'string' && key.startsWith('pr_addr_')) return real[key];
      return () => { throw new Error(`stub: ${String(key)} traps`); };
    },
  });
}
/**
 * Run `fn` with `stub` as the backend. A throw from the backend drops the instance (the next call gets a fresh one),
 * so a stub serves one failing call: use one `under` per call that must fail.
 */
function under(stub, fn) {
  rules.setRulesExportsForTests(stub);
  try {
    return fn();
  } finally {
    rules.setRulesExportsForTests(null);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const NAMES = [
  ...legacy.SECRET_NAMES, ...legacy.CONTROL_NAMES,
  '.env.local', '.env.production', '.env.', 'x.key', 'a.PEM', 'b.p12', 'c.pfx', 'd.jks', 'e.keystore', 'f.env', 'my.envrc',
  'src', 'lib', 'index.ts', 'README.md', 'a', 'b', 'dir', 'docs', 'node_modules', 'name', 'x.y', 'envx', 'env', 'keys', 'key', 'pem',
  '.environment', '..', '.', '...', '', 'CLAUDE.md', 'Agents.MD',
];
const MARKS = ['\u200b', '\u200d', '\u00ad', '\ufeff', '\u2060', '\u180e', '\u{e0041}', '\ufe0f'];
const LOOKALIKE = { k: '\u212a', K: '\u212a', s: '\u017f', e: '\uff45', i: '\u0131', c: '\uff43', n: '\uff4e', v: '\uff56', '/': '\uff0f', '.': '\uff0e', g: '\uff47', t: '\uff54' };
const POOL = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._- ~'], WIDE = ['\u00e9', '\u00fc', '\u00df', '\u00f1', '\u4e2d', '\u65e5', '\u{1f600}', '\u212a', '\ufb01', '\u0130', '\u0301', '\u2160', '\uff0f'];
const SEPS = ['/', '/', '/', '/', '\\', '//', '/./', '/../', '\\/', '/ ', ' /', '\\\\'];
const PREFIXES = ['', '', '', '/', 'C:\\', './', '../', '/home/u/', '~/', '/tmp/'];

function decorate(rnd, name) {
  let out = '';
  for (const ch of name) {
    let c = ch;
    if (rnd() < 0.12) c = c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
    if (rnd() < 0.05 && LOOKALIKE[c]) c = LOOKALIKE[c];
    out += c;
    if (rnd() < 0.04) out += pick(rnd, MARKS);
  }
  if (rnd() < 0.12) out += pick(rnd, ['.', ' ', '. ', '..', ' .', '. . ']);
  return out;
}

function randomWord(rnd) {
  let s = '';
  const n = below(rnd, 12);
  for (let i = 0; i < n; i++) s += rnd() < 0.12 ? pick(rnd, WIDE) : pick(rnd, POOL);
  return s;
}

function genPath(rnd) {
  const segs = [];
  const n = 1 + below(rnd, 6);
  for (let i = 0; i < n; i++) segs.push(rnd() < 0.55 ? decorate(rnd, pick(rnd, NAMES)) : decorate(rnd, randomWord(rnd)));
  let p = pick(rnd, PREFIXES);
  segs.forEach((s, i) => { p += (i > 0 ? pick(rnd, SEPS) : '') + s; });
  if (rnd() < 0.01) {
    const chars = [...p];
    const at = below(rnd, chars.length + 1);
    p = `${chars.slice(0, at).join('')}\0${chars.slice(at).join('')}`;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

describe('specs/tables/path_tables.mjs', () => {
  it('holds the name lists of the old pathGuard.ts, and specs/path_tables.t27 is generated from them', async () => {
    const tables = await import('../specs/tables/path_tables.mjs');
    assert.deepEqual(tables.SECRET_NAMES, legacy.SECRET_NAMES);
    assert.deepEqual(tables.SECRET_PREFIXES, legacy.SECRET_PREFIXES);
    assert.deepEqual(tables.SECRET_SUFFIXES, legacy.SECRET_SUFFIXES);
    assert.deepEqual(tables.CONTROL_NAMES, legacy.CONTROL_NAMES);
    assert.equal(readFileSync(path.join(ROOT, 'specs', 'path_tables.t27'), 'utf8'), tables.renderPathTables());
  });
});

// ---------------------------------------------------------------------------
// bytes_rules against the old helpers
// ---------------------------------------------------------------------------

describe('bytes_rules against isSeparator and foldAscii of the old pathGuard.ts', () => {
  it('equal for every byte and both flags', () => {
    for (let b = 0; b < 256; b++) {
      const got = rules.callRules(x => [x.by_fold_ascii(b), x.by_is_sep(b, 0), x.by_is_sep(b, 1)], null);
      assert.deepEqual(got, [legacy.foldAscii(b), +legacy.isSeparator(b, false), +legacy.isSeparator(b, true)], `byte ${b}`);
    }
    count('bytes', 256);
  });
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

const EDGE_PATHS = [
  '', '/', '.', '..', 'a', 'a/b/c.txt', 'src/index.ts', 'README.md', '.env', '.ENV', '.Env', 'a/.env', 'a/../.env', 'a\\.env', '.env.', '.env ', '.env. . ', ' .env',
  '.env.local', '.ENV.LOCAL', '.env.production', 'x.env', 'x.ENV', '.envrc', '.environment', 'env', 'config/.npmrc', '.netrc', '.pypirc', '.pgpass', '.git-credentials',
  'id_rsa', 'ID_RSA', 'id_rsa.pub', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'x/credentials/y', '.aws/config', '.ssh/id_rsa', '.docker/config.json', '.kube/config', '.gnupg/x',
  'a.key', 'a.KEY', 'dir/sub/x.Key', 'cert.pem', 'cert.p12', 'cert.pfx', 'store.jks', 'store.keystore', 'keystore', 'key', 'pem',
  '.git', '.git/hooks/pre-commit', 'a/.GIT/b', '.cursor/rules', '.cursorrules', '.vscode/settings.json', '.claude/x', '.m7/state', '.husky/pre-commit', '.github/workflows/x.yml', '.mcp.json',
  'CLAUDE.md', 'claude.md', 'sub/Agents.md', 'GEMINI.MD', '.clinerules', '.windsurfrules', '.devcontainer/x', '.idea/x', '.gitmodules', '.gitattributes', '.gitignore', 'git',
  '.Cur\u017forrules', '.\u00dfh', '.\u00dfh/x', '.en\u200bv', '.en\ufeffv', '.e\u00adnv', '.\uff45nv', '\uff0eenv', 'a\uff0f.env', 'a\uff0f.git', '.\u212aey', 'a.\u212aey', 'a.\u212a\u0045Y', '.g\u0131t', '.G\u0130T',
  'a\0b', 'ok.txt\0', '\0', '.env\0', '/\0/', 'a//b', '//a//.env//', '\\\\', '/./.env', '/../.env/..', '...', 'a. ', 'a ', '. ', '.. ', ' ',
  '\u4e2d\u6587/.env', 'caf\u00e9/.git', '\u{1F600}/x', '\u{1F600}.env', 'a\u0301/.env', '\ufdfa', '\ufdfa/.env', '\u0130.env',
];

describe('pushRefusal and pullRefusal against the old pathGuard.ts', () => {
  it('equal on the hand-written paths', () => {
    EDGE_PATHS.forEach((p, i) => {
      same('push', i, p, guard.pushRefusal(p), legacy.pushRefusal(p));
      same('pull', i, p, guard.pullRefusal(p), legacy.pullRefusal(p));
    });
    count('verdictEdgePaths', EDGE_PATHS.length);
  });

  it('equal when one character of every value 0..255 stands at each position of the names that matter', T, () => {
    const names = ['.env', '.git', 'a.key', 'id_rsa', 'x.pem', 'claude.md', '.env.local', 'credentials', 'src', '.ssh'];
    let n = 0;
    for (const name of names) {
      for (let c = 0; c < 256; c++) {
        const ch = String.fromCharCode(c);
        for (let i = 0; i <= name.length; i++) {
          const variants = [`${name.slice(0, i)}${ch}${name.slice(i)}`];
          if (i < name.length) variants.push(`${name.slice(0, i)}${ch}${name.slice(i + 1)}`);
          for (const v of variants) {
            for (const p of [v, `dir/${v}`, `${v}/dir`, `dir\\${v}`]) {
              same('push', n, p, guard.pushRefusal(p), legacy.pushRefusal(p));
              same('pull', n, p, guard.pullRefusal(p), legacy.pullRefusal(p));
              n++;
            }
          }
        }
      }
    }
    count('verdictBytePositions', n);
  });

  it(`equal on ${N_PATHS} seeded paths with the edge shapes (.ENV, a/../.env, trailing dots and spaces, backslash, NUL, multibyte, full-width solidus, zero-width and Kelvin letters, segments that fold to empty)`, T, () => {
    const rnd = mulberry32(SEED);
    let compared = 0;
    let secret = 0;
    let control = 0;
    let nul = 0;
    for (let i = 0; i < N_PATHS; i++) {
      const p = genPath(rnd);
      if (bytes(p) > 4096) continue;
      const push = legacy.pushRefusal(p);
      const pull = legacy.pullRefusal(p);
      same('push', i, p, guard.pushRefusal(p), push);
      same('pull', i, p, guard.pullRefusal(p), pull);
      compared++;
      if (push === legacy.REFUSE_SECRET) secret++;
      if (pull === legacy.REFUSE_CONTROL) control++;
      if (push === legacy.REFUSE_NUL) nul++;
    }
    assert.ok(compared > N_PATHS * 0.99, `[seed ${SEED}] only ${compared} of ${N_PATHS} paths were inside the limit`);
    assert.ok(secret > 5000 && control > 5000 && nul > 500, `[seed ${SEED}] the generator must hit every verdict: secret ${secret}, control ${control}, nul ${nul}`);
    count('verdictSeededPaths', compared);
    count('verdictSeededSecret', secret);
    count('verdictSeededControl', control);
    count('verdictSeededNul', nul);
  });

  it('foldName, trimTrailingDotSpace and pathSegments equal the old ones on seeded input', () => {
    const rnd = mulberry32(SEED + 1);
    let n = 0;
    for (let i = 0; i < 20_000; i++) {
      const p = genPath(rnd);
      if (bytes(p) > 4096) continue;
      same('pathSegments', i, p, JSON.stringify(guard.pathSegments(p)), JSON.stringify(legacy.pathSegments(p)));
      for (const seg of legacy.pathSegments(p)) {
        same('foldName', i, seg, guard.foldName(seg), legacy.foldName(seg));
        same('trim', i, seg, guard.trimTrailingDotSpace(seg), legacy.trimTrailingDotSpace(seg));
        n++;
      }
    }
    const alphabet = ['.', ' ', 'a', '\u00e9'];
    const all = [''];
    let level = [''];
    for (let len = 1; len <= 6; len++) {
      level = level.flatMap(s => alphabet.map(c => s + c));
      all.push(...level);
    }
    all.forEach((s, i) => same('trim (all strings over . space a e-acute, length <= 6)', i, s, guard.trimTrailingDotSpace(s), legacy.trimTrailingDotSpace(s)));
    count('foldSegments', n);
    count('trimAllShortStrings', all.length);
  });
});

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

const PLATFORMS = ['darwin', 'win32'];

describe('isInsideWith, isInside and relativeWithin against the old pathGuard.ts', () => {
  it('equal for every pair over a small alphabet, both flags (root up to 3 characters, target up to 4)', () => {
    const alphabet = ['a', 'A', '/', '\\'];
    const strings = [''];
    let level = [''];
    for (let len = 1; len <= 4; len++) {
      level = level.flatMap(s => alphabet.map(c => s + c));
      strings.push(...level);
    }
    let n = 0;
    for (const root of strings.filter(s => s.length <= 3)) {
      for (const target of strings) {
        for (const win of [false, true]) {
          same(`isInsideWith win=${win}`, n, [root, target], guard.isInsideWith(root, target, win), legacy.isInsideWith(root, target, win));
          n++;
        }
      }
    }
    count('insideSmallAlphabet', n);
  });

  it('equal when one character of every value 0..255 stands in the root or the target', () => {
    let n = 0;
    for (let c = 0; c < 256; c++) {
      const ch = String.fromCharCode(c);
      const roots = ['/x', `/x${ch}`, `${ch}/x`, `/${ch}x`, ch, `C:\\X${ch}`];
      const targets = ['/x', '/x/', `/x/${ch}`, `/x${ch}`, `/x${ch}/y`, `${ch}/x/y`, `/${ch}x/y`, ch, `${ch}${ch}`, 'c:/x', `c:/x${ch}/z`, `C:\\x\\${ch}`];
      for (const root of roots) {
        for (const target of targets) {
          for (const win of [false, true]) {
            same(`isInsideWith win=${win}`, n, [root, target], guard.isInsideWith(root, target, win), legacy.isInsideWith(root, target, win));
            n++;
          }
        }
      }
    }
    count('insideBytePositions', n);
  });

  it('equal on seeded pairs: a path, and the same path changed in one place; isInside and relativeWithin on both platforms', T, () => {
    const rnd = mulberry32(SEED + 2);
    let n = 0;
    for (let i = 0; i < 60_000; i++) {
      const root = genPath(rnd);
      let target;
      switch (below(rnd, 7)) {
        case 0: target = root; break;
        case 1: target = root + pick(rnd, SEPS) + genPath(rnd); break;
        case 2: target = root + randomWord(rnd); break;
        case 3: target = root.toUpperCase(); break;
        case 4: target = root.replace(/\//g, '\\') + pick(rnd, ['', '\\x', '/x']); break;
        case 5: target = [...root].slice(0, below(rnd, [...root].length + 1)).join(''); break;
        default: target = genPath(rnd);
      }
      if (bytes(root) > 4096 || bytes(target) > 4096 || !root.isWellFormed() || !target.isWellFormed()) continue;
      for (const win of [false, true]) {
        same(`isInsideWith win=${win}`, i, [root, target], guard.isInsideWith(root, target, win), legacy.isInsideWith(root, target, win));
      }
      for (const platform of PLATFORMS) {
        onPlatform(platform, () => {
          same(`isInside ${platform}`, i, [root, target], guard.isInside(root, target), legacy.isInside(root, target));
          same(`relativeWithin ${platform}`, i, [root, target], guard.relativeWithin(root, target), legacy.relativeWithin(root, target));
        });
      }
      n++;
    }
    count('insideSeededPairs', n);
  });

  it('relativeWithin: the relative part, the empty string for the root itself, null outside', () => {
    onPlatform('darwin', () => {
      assert.equal(guard.relativeWithin('/a/b', '/a/b/c/d'), 'c/d');
      assert.equal(guard.relativeWithin('/a/b', '/a/b'), '');
      assert.equal(guard.relativeWithin('/a/b', '/a/b///c'), 'c');
      assert.equal(guard.relativeWithin('/a/b', '/a/bc'), null);
      assert.equal(guard.relativeWithin('/a/b', '/a'), null);
      assert.equal(guard.relativeWithin('/a/b/', '/a/b/c'), 'c');
      assert.equal(guard.relativeWithin('/a/b', '/a/b/caf\u00e9/\u{1f600}'), 'caf\u00e9/\u{1f600}');
    });
  });
});

describe('linkLeavesRoot and isPlainEntryName against the old pathGuard.ts', () => {
  it('linkLeavesRoot equals the old one for a missing target, inside, outside and a bare prefix', () => {
    const pairs = [['/p', null], ['/p', '/p'], ['/p', '/p/a/b'], ['/p', '/q/x'], ['/p', '/p-evil/x'], ['/p/', '/p/x'], ['', '/p'], ['/p', ''], ['C:\\p', 'c:\\P\\x']];
    pairs.forEach(([root, real], i) => {
      for (const platform of PLATFORMS) onPlatform(platform, () => same(`linkLeavesRoot ${platform}`, i, [root, real], guard.linkLeavesRoot(root, real), legacy.linkLeavesRoot(root, real)));
    });
    count('linkLeavesRoot', pairs.length * 2);
  });

  it('isPlainEntryName equals the old one for the special names, every single character and seeded names', () => {
    const names = ['', '.', '..', '...', 'a', 'a b', 'a\0', '\0', 'a/b', '.hidden', 'caf\u00e9', '\u{1f600}', '. ', ' .'];
    for (let c = 0; c < 256; c++) names.push(String.fromCharCode(c), `a${String.fromCharCode(c)}`, `${String.fromCharCode(c)}.`);
    const rnd = mulberry32(SEED + 3);
    for (let i = 0; i < 20_000; i++) names.push(rnd() < 0.3 ? pick(rnd, NAMES) : randomWord(rnd));
    names.forEach((name, i) => same('isPlainEntryName', i, name, guard.isPlainEntryName(name), legacy.isPlainEntryName(name)));
    count('isPlainEntryName', names.length);
  });
});

// ---------------------------------------------------------------------------
// projectPath.ts
// ---------------------------------------------------------------------------

describe('selectProjectSource, needsProjectSwitch and the unsafe-fallback rule against the old projectPath.ts', () => {
  it('selectProjectSource equals the old one for all 32 combinations of the five facts', () => {
    let n = 0;
    for (let m = 0; m < 32; m++) {
      const facts = { hasCursorEnv: !!(m & 1), hasAgentTranscripts: !!(m & 2), hasValidM7Path: !!(m & 4), rootsComplete: !!(m & 8), cwdAllowsScan: !!(m & 16) };
      same('selectProjectSource', m, facts, pp.selectProjectSource(facts), legacyPP.selectProjectSource(facts));
      n++;
    }
    count('selectProjectSource', n);
  });

  it('needsProjectSwitch equals the old one for null, equal, spelled-differently and different paths', () => {
    const paths = ['/a/b', '/a/b/', '/a//b', '/a/./b', '/a/b/..', '/a', '/', '', '.', '..', 'a', 'a/..', '/a/b/../b', '/tmp/x', 'relative/p', '/a/b/caf\u00e9', '/A/B', '/a/b/\u{1f600}', 'x/../y', '/a/b\0'];
    let n = 0;
    for (const next of paths) {
      same('needsProjectSwitch(null)', n++, [null, next], pp.needsProjectSwitch(null, next), legacyPP.needsProjectSwitch(null, next));
      for (const current of paths) same('needsProjectSwitch', n++, [current, next], pp.needsProjectSwitch(current, next), legacyPP.needsProjectSwitch(current, next));
    }
    const rnd = mulberry32(SEED + 4);
    for (let i = 0; i < 20_000; i++) {
      const a = genPath(rnd);
      const b = rnd() < 0.5 ? a + pick(rnd, ['', '/', '/.', '//', '/x/..']) : genPath(rnd);
      if (bytes(a) > 4000 || bytes(b) > 4000) continue;
      same('needsProjectSwitch', n++, [a, b], pp.needsProjectSwitch(a, b), legacyPP.needsProjectSwitch(a, b));
    }
    count('needsProjectSwitch', n);
  });

  it('the unsafe-fallback rule equals the old isUnsafeFallbackPath for the home folder with and without a project marker, and for other folders', async () => {
    const { unsafeFallback } = await import('../dist/rules/pathRules.js');
    const base = mkdtempSync(path.join(tmpdir(), 'rules-home-'));
    const savedHome = process.env.HOME;
    try {
      const empty = path.join(base, 'home-empty');
      const marked = path.join(base, 'home-marked');
      const other = path.join(base, 'other');
      for (const d of [empty, marked, other]) mkdirSync(d);
      writeFileSync(path.join(marked, 'package.json'), '{}');
      let n = 0;
      for (const [home, dir] of [[empty, empty], [marked, marked], [empty, other], [marked, other], [empty, path.join(empty, 'sub')], [empty, `${empty}/`], [empty, path.join(base, 'missing')]]) {
        process.env.HOME = home;
        const want = legacyPP.isUnsafeFallbackPath(dir);
        const got = unsafeFallback(legacyPP.isBareHomeDirectory(dir), () => legacyPP.isValidProjectDirectory(dir));
        same('unsafeFallback', n++, [home, dir], got, want);
      }
      count('unsafeFallback', n);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('the unsafe-fallback rule is true only for a home folder without a project marker, for all four combinations', async () => {
    const { unsafeFallback } = await import('../dist/rules/pathRules.js');
    assert.equal(unsafeFallback(true, () => false), true);
    assert.equal(unsafeFallback(true, () => true), false);
    assert.equal(unsafeFallback(false, () => false), false);
    assert.equal(unsafeFallback(false, () => true), false);
    assert.equal(unsafeFallback(false, () => { throw new Error('not asked'); }), false, 'the marker is not looked at for a folder that is not the home folder');
  });
});

// ---------------------------------------------------------------------------
// New behaviour: limits, lone surrogates, a failing backend
// ---------------------------------------------------------------------------

describe('New behaviour: limits and unwritable text', () => {
  it('an over-long path ending in .env is refused', () => {
    const p = `${'a/'.repeat(2500)}.env`;
    assert.ok(bytes(p) > 4096);
    assert.equal(guard.pushRefusal(p), guard.REFUSE_TOO_LONG);
    assert.equal(guard.pullRefusal(p), guard.REFUSE_TOO_LONG);
    assert.equal(typeof guard.REFUSE_TOO_LONG, 'string');
  });

  it('an over-long harmless path is refused', () => {
    const p = `${'a/'.repeat(2500)}b`;
    assert.ok(bytes(p) > 4096);
    assert.equal(guard.pushRefusal(p), guard.REFUSE_TOO_LONG);
    assert.equal(guard.pullRefusal(p), guard.REFUSE_TOO_LONG);
  });

  it('a lone surrogate in a path is refused', () => {
    for (const p of ['a\ud800b', '\udc00', 'x/\ud83d', '\ud83dx/.env', 'ok/\udfff']) {
      assert.equal(guard.pushRefusal(p), guard.REFUSE_BAD_TEXT, JSON.stringify(p));
      assert.equal(guard.pullRefusal(p), guard.REFUSE_BAD_TEXT, JSON.stringify(p));
    }
    assert.equal(typeof guard.REFUSE_BAD_TEXT, 'string');
    assert.equal(guard.pushRefusal('a/\u{1f600}/b'), null, 'a surrogate pair is fine');
  });

  it('isInside refuses text over the limit', () => {
    const inside = `/p/${'x'.repeat(5000)}`;
    assert.equal(legacy.isInsideWith('/p', inside, false), true, 'the oracle says inside');
    assert.equal(guard.isInside('/p', inside), false);
    assert.equal(guard.isInsideWith('/p', inside, false), false);
    assert.equal(guard.isInsideWith('/p', inside, true), false);
    assert.equal(guard.isInsideWith(`/${'r'.repeat(5000)}`, `/${'r'.repeat(5000)}/x`, false), false, 'a root over the limit');
    assert.equal(guard.relativeWithin('/p', inside), null);
    assert.equal(guard.isPlainEntryName('n'.repeat(5000)), false);
  });

  it('the limit is 4096 bytes of UTF-8 for a path: 4095 and 4096 are checked, 4097 is refused, /.env past the limit is refused as too long', () => {
    const exact = (n, tail = '') => `${'a'.repeat(n - tail.length)}${tail}`;
    assert.equal(guard.pushRefusal(exact(4095, '/.env')), guard.REFUSE_SECRET);
    assert.equal(guard.pushRefusal(exact(4096, '/.env')), guard.REFUSE_SECRET);
    assert.equal(guard.pushRefusal(exact(4097, '/.env')), guard.REFUSE_TOO_LONG);
    assert.equal(guard.pushRefusal(exact(4095)), null);
    assert.equal(guard.pushRefusal(exact(4096)), null);
    assert.equal(guard.pushRefusal(exact(4097)), guard.REFUSE_TOO_LONG);
    assert.equal(guard.pullRefusal(exact(4096, '/.git')), guard.REFUSE_CONTROL);
    assert.equal(guard.pullRefusal(exact(4097, '/.git')), guard.REFUSE_TOO_LONG);
    // The limit counts bytes, not characters: 2048 two-byte characters fit, 2049 do not.
    assert.equal(guard.pushRefusal('\u00e9'.repeat(2048)), null);
    assert.equal(guard.pushRefusal('\u00e9'.repeat(2049)), guard.REFUSE_TOO_LONG);
    assert.equal(guard.isInsideWith('/p', `/p/${'x'.repeat(4093)}`, false), true, '4096 bytes');
    assert.equal(guard.isInsideWith('/p', `/p/${'x'.repeat(4094)}`, false), false, '4097 bytes');
    assert.equal(legacy.pushRefusal(exact(4097, '/.env')), legacy.REFUSE_SECRET, 'the oracle had no limit');
  });

  it('the folded text has a limit of 16384 bytes: growth past it is refused, 16384 is checked', () => {
    // U+FDFA is 3 bytes and folds to 33 bytes.
    const fold = (k, m, tail = '') => `${'\ufdfa'.repeat(k)}${'a'.repeat(m)}${tail}`;
    const joined = (k, m) => 33 * k + m + 1;
    assert.equal(joined(480, 543), 16384);
    assert.equal(guard.pushRefusal(fold(480, 543)), null, 'joined text of exactly 16384 bytes');
    assert.equal(guard.pushRefusal(fold(480, 544)), guard.REFUSE_TOO_LONG, 'one byte more');
    assert.equal(guard.pushRefusal(fold(500, 0)), guard.REFUSE_TOO_LONG);
    assert.equal(guard.pullRefusal(fold(1300, 0)), guard.REFUSE_TOO_LONG, '3900 bytes in, 42900 bytes out');
    assert.equal(legacy.pushRefusal(fold(1300, 0)), null, 'the oracle had no limit');
    assert.equal(guard.pushRefusal(fold(480, 543 - 5, '/.env')), guard.REFUSE_SECRET, 'a secret name at the end of a text that just fits');
    assert.equal(guard.pushRefusal(fold(480, 543 - 4, '/.env')), guard.REFUSE_TOO_LONG, 'and one byte more');
  });

  it('a NUL byte is refused with the NUL reason, also when the text has a secret name', () => {
    assert.equal(guard.pushRefusal('a\0b'), guard.REFUSE_NUL);
    assert.equal(guard.pushRefusal('.env\0'), guard.REFUSE_NUL);
    assert.equal(guard.pullRefusal('a/.git\0'), guard.REFUSE_NUL);
  });

  it('isInsideWith, relativeWithin and linkLeavesRoot refuse a lone surrogate, where the oracle compared code units', () => {
    assert.equal(legacy.isInsideWith('/a\ud800', '/a\ud800/b', false), true, 'the oracle compared code units');
    assert.equal(guard.isInsideWith('/a\ud800', '/a\ud800/b', false), false);
    assert.equal(guard.isInsideWith('/a\ud800', '/a\ud801/b', false), false, 'two different lone surrogates do not become equal');
    assert.equal(guard.isInsideWith('/a', '/a/\udc00', true), false);
    assert.equal(onPlatform('darwin', () => guard.relativeWithin('/a', '/a/\udc00')), null);
    assert.equal(guard.linkLeavesRoot('/a', '/a/\udc00'), true);
    assert.equal(guard.isPlainEntryName('a\ud800'), false);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed values with a failing backend
// ---------------------------------------------------------------------------

describe('A failing backend gives the refusing value of each rule', () => {
  const none = { hasCursorEnv: false, hasAgentTranscripts: false, hasValidM7Path: false, rootsComplete: false, cwdAllowsScan: false };

  it('the verdicts refuse with REFUSE_RULES', () => {
    assert.equal(under(brokenRules(), () => guard.pushRefusal('src/index.ts')), guard.REFUSE_RULES);
    assert.equal(under(brokenRules(), () => guard.pullRefusal('src/index.ts')), guard.REFUSE_RULES);
    assert.equal(under(brokenRules(), () => guard.pushRefusal('')), guard.REFUSE_RULES);
    assert.equal(typeof guard.REFUSE_RULES, 'string');
  });

  it('isInside is false, relativeWithin is null, linkLeavesRoot is true, isPlainEntryName is false', () => {
    assert.equal(under(brokenRules(), () => guard.isInside('/a', '/a/b')), false);
    assert.equal(under(brokenRules(), () => guard.isInsideWith('/a', '/a/b', false)), false);
    assert.equal(under(brokenRules(), () => guard.relativeWithin('/a', '/a/b')), null);
    assert.equal(under(brokenRules({ pr_is_inside: () => 1 }), () => guard.linkLeavesRoot('/a', '/a/b')), true, 'the link function itself fails; the right answer is false');
    assert.equal(under(brokenRules(), () => guard.linkLeavesRoot('/a', null)), true);
    assert.equal(under(brokenRules(), () => guard.isPlainEntryName('file.txt')), false);
  });

  it('selectProjectSource throws, so nothing is written', () => {
    const facts = { ...none, hasCursorEnv: true };
    assert.throws(() => under(brokenRules(), () => pp.selectProjectSource(facts)), rules.RulesUnavailableError);
  });

  it('needsProjectSwitch is true, also for equal paths and for no current path', () => {
    assert.equal(under(brokenRules(), () => pp.needsProjectSwitch('/a/b', '/a/b')), true);
    assert.equal(under(brokenRules(), () => pp.needsProjectSwitch(null, '/a/b')), true);
  });

  it('the unsafe-fallback rule is true', async () => {
    const { unsafeFallback } = await import('../dist/rules/pathRules.js');
    assert.equal(under(brokenRules(), () => unsafeFallback(false, () => true)), true);
    assert.equal(under(brokenRules(), () => unsafeFallback(true, () => true)), true);
  });

  it('foldName and trimTrailingDotSpace leave the text as it is (comparison only), pathSegments throws', () => {
    assert.equal(under(brokenRules(), () => guard.trimTrailingDotSpace('name. .')), 'name. .');
    assert.equal(under(brokenRules(), () => guard.foldName('NAME. .')), 'name. .', 'folded by the platform, not trimmed');
    assert.throws(() => under(brokenRules(), () => guard.pathSegments('a/b')), rules.RulesUnavailableError);
  });

  it('a backend that answers a code the facade does not know is a failure too', () => {
    const verdicts = { pr_has_nul: () => 0, pr_seg_start: () => -1 };
    assert.equal(under(brokenRules({ ...verdicts, pr_push_verdict: () => 7 }), () => guard.pushRefusal('a')), guard.REFUSE_RULES, 'a verdict code 7');
    assert.equal(under(brokenRules({ ...verdicts, pr_pull_verdict: () => -1 }), () => guard.pullRefusal('a')), guard.REFUSE_RULES, 'a verdict code -1');
    assert.equal(under(brokenRules({ pr_has_nul: () => 0, pr_seg_start: () => -2, pr_push_verdict: () => 0 }), () => guard.pushRefusal('a/.env')), guard.REFUSE_RULES,
      'the segment scan reports an error, which is not "no more segments"');
    assert.equal(under(brokenRules({ pr_has_nul: () => 0, pr_seg_start: () => 0, pr_seg_end: () => 0 }), () => guard.pushRefusal('a')), guard.REFUSE_RULES, 'a segment that ends where it starts');
    assert.equal(under(brokenRules({ pr_has_nul: () => 0, pr_seg_start: () => 0, pr_seg_end: () => 99 }), () => guard.pushRefusal('a')), guard.REFUSE_RULES, 'a segment that ends past the text');
    assert.equal(under(brokenRules({ pr_trim_end: () => 99 }), () => guard.pushRefusal('a/.env')), guard.REFUSE_RULES, 'a trimmed length longer than the text');
    assert.equal(under(brokenRules({ pr_trim_end: () => -1 }), () => guard.pullRefusal('a/.git')), guard.REFUSE_RULES, 'a trim that reports an error');
    assert.equal(under(brokenRules({ pr_trim_end: () => 99 }), () => guard.trimTrailingDotSpace('a.')), 'a.', 'the public trim keeps the text when the rules answer nonsense');
    assert.throws(() => under(brokenRules({ pr_seg_start: () => 5 }), () => guard.pathSegments('ab')), rules.RulesUnavailableError, 'a segment that starts past the text');
    assert.throws(() => under(brokenRules({ pr_env_source: () => 9 }), () => pp.selectProjectSource(none)), rules.RulesUnavailableError);
    assert.equal(under(brokenRules({ pr_is_inside: () => 2 }), () => guard.isInsideWith('/a', '/a/b', false)), false, 'a bool must be exactly 0 or 1');
    assert.equal(under(brokenRules({ pr_relative_start: () => 99 }), () => guard.relativeWithin('/a', '/a/b')), null, 'a start index past the text');
    assert.equal(under(brokenRules({ pr_relative_start: () => 0 }), () => guard.relativeWithin('/a', '/a/b')), null, 'a start index inside the root');
    assert.equal(under(brokenRules({ pr_plain_entry_name: () => 3 }), () => guard.isPlainEntryName('x')), false);
    assert.equal(under(brokenRules({ pr_is_inside: () => 1, pr_link_leaves: () => 2 }), () => guard.linkLeavesRoot('/a', '/a/b')), true, 'the right answer is false');
    assert.equal(under(brokenRules({ pr_needs_switch: () => 5 }), () => pp.needsProjectSwitch('/a', '/a')), true, 'the right answer is false');
  });

  it('a backend that traps once does not poison the next call: the instance is replaced', () => {
    assert.equal(under(brokenRules(), () => guard.isInside('/a', '/a/b')), false);
    assert.equal(guard.isInside('/a', '/a/b'), true, 'the real rules answer again');
    assert.equal(guard.pushRefusal('.env'), guard.REFUSE_SECRET);
  });

  it('a fold that makes a NUL byte or a lone surrogate is refused, and a fold that throws fails the verdict', async () => {
    const { pushVerdict, pullVerdict } = await import('../dist/rules/pathRules.js');
    assert.equal(pushVerdict('a/b', () => 'x\0y'), guard.REFUSE_RULES, 'a NUL inside a folded segment would move the segment border');
    assert.equal(pullVerdict('a/b', () => '\ud800'), guard.REFUSE_BAD_TEXT);
    assert.equal(pushVerdict('a/b', () => { throw new Error('fold failed'); }), guard.REFUSE_RULES);
    assert.equal(pushVerdict('a/.env', s => s), guard.REFUSE_SECRET, 'and a plain fold works');
  });
});

// ---------------------------------------------------------------------------
// The old code is gone from the sources
// ---------------------------------------------------------------------------

describe('The decisions left the TypeScript', () => {
  it('pathGuard.ts and projectPath.ts no longer hold the name lists or the byte helpers', () => {
    const g = readFileSync(path.join(ROOT, 'src', 'core', 'security', 'pathGuard.ts'), 'utf8');
    assert.doesNotMatch(g, /SECRET_NAMES|SECRET_SUFFIXES|CONTROL_NAMES|function isSeparator|function foldAscii|function isSecretSegment|function isControlSegment/);
    const p = readFileSync(path.join(ROOT, 'src', 'core', 'utils', 'projectPath.ts'), 'utf8');
    assert.doesNotMatch(p, /if \(facts\.hasCursorEnv\)|resolve\(current\) !== resolve\(next\)/);
  });

  it('the generated constants hold the limits the facade writes into', () => {
    const c = readFileSync(path.join(ROOT, 'src', 'rules', 'generated', 'constants.ts'), 'utf8');
    assert.match(c, /export const PR_PATH_MAX = 4096;/);
    assert.match(c, /export const PR_FOLDED_MAX = 16384;/);
  });
});
