// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * The write-policy rules (specs/policy_rules.t27) against the TypeScript they replace.
 *
 * The oracles are the old code, transpiled at commit c41f8ce by scripts/make-oracle.mjs:
 *   tests/oracles/safeWriteLegacy.mjs          src/core/utils/safeWrite.ts            hasManagedMarker, managedStateOf,
 *                                                                                     managedWriteAction, managedSyncAction
 *   tests/oracles/initProjectLegacy.mjs        src/core/tools/initProject.ts          isEmptyListing, needsInitNoteFor
 *   tests/oracles/anthropicParamsLegacy.mjs    src/hive/api/anthropicParams.ts        modelTakesTemperature
 *   tests/oracles/intentClassifierLegacy.mjs   src/core/intelligence/intentClassifier.ts   isRemoteClassificationEnabled
 * Every test compares the public functions of dist/ with the oracle on the same input. Inside the limits
 * they must agree. The cases under "New behaviour" are the only ones where they may differ, and each says why:
 *   - a model name or an environment value over 256 bytes: no temperature, no remote classification;
 *   - a listing over 65536 bytes (the names, each followed by a NUL byte): not empty;
 *   - text that UTF-8 cannot carry (a lone surrogate): the refusing value;
 *   - a failing backend: the refusing value of each rule (marker no, state foreign, write skip, sync skip,
 *     listing not empty, no init note, no temperature, no remote classification).
 *
 * The 4096-byte window of the managed marker is a rule of the spec: a marker that ends after byte 4096 is not
 * found. Tests cross that edge from both sides.
 *
 * Seed: the random cases use M7_RULES_SEED (default 27). Every failure message starts with the seed and the
 * case number: M7_RULES_SEED=<seed> node --test tests/rulesPolicy.test.mjs
 *
 * Run: npm run build && node --test --test-force-exit tests/rulesPolicy.test.mjs
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import * as legacyAp from './oracles/anthropicParamsLegacy.mjs';
import * as legacyIc from './oracles/intentClassifierLegacy.mjs';
import * as legacyIp from './oracles/initProjectLegacy.mjs';
import * as legacySw from './oracles/safeWriteLegacy.mjs';

const sw = await import('../dist/core/utils/safeWrite.js');
const ip = await import('../dist/core/tools/initProject.js');
const ap = await import('../dist/hive/api/anthropicParams.js');
const ic = await import('../dist/core/intelligence/intentClassifier.js');
const rules = await import('../dist/rules/wasm.js');

const SEED = Number(process.env.M7_RULES_SEED ?? 27);
const N_RANDOM = 100_000;
const T = { timeout: 110_000 };
const enc = new TextEncoder();
const bytes = s => enc.encode(s).length;
const MARKER = legacySw.M7_MANAGED_MARKER;

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
  console.log(`rulesPolicy: seed ${SEED}; cases compared with the oracle: ${JSON.stringify(counts)}`);
});

function same(label, i, input, got, want) {
  if (got !== want) {
    const shown = typeof input === 'string' && input.length > 200 ? `${input.slice(0, 100)}...(${input.length} characters)` : input;
    assert.fail(`[seed ${SEED}] ${label} case ${i}: input ${JSON.stringify(shown)}\n  new:    ${JSON.stringify(got)}\n  oracle: ${JSON.stringify(want)}`);
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
      if (typeof key === 'string' && /^(pr|nr|po)_addr_/.test(key)) return real[key];
      return () => { throw new Error(`stub: ${String(key)} traps`); };
    },
  });
}
/** A throw from the backend drops the instance, so a stub serves one failing call: one `under` per call. */
function under(stub, fn) {
  rules.setRulesExportsForTests(stub);
  try {
    return fn();
  } finally {
    rules.setRulesExportsForTests(null);
  }
}

// ---------------------------------------------------------------------------
// The managed marker and the write states
// ---------------------------------------------------------------------------

describe('hasManagedMarker against the old safeWrite.ts', () => {
  it('the marker is the same text and the window the same size', () => {
    assert.equal(sw.M7_MANAGED_MARKER, legacySw.M7_MANAGED_MARKER);
    assert.equal(sw.MANAGED_SCAN_BYTES, legacySw.MANAGED_SCAN_BYTES);
    assert.equal(bytes(MARKER), 19);
  });

  it('equal on the hand-written contents', () => {
    const near = MARKER.slice(0, -1);
    const contents = [
      '', 'x', MARKER, `${MARKER}\n`, `\n${MARKER}`, `text ${MARKER} text`, near, `${near}x`, MARKER.toUpperCase(), MARKER.replace('m7', 'm8'), MARKER.replace(' ', '  '),
      `<!--${MARKER.slice(4)}`, `${MARKER.slice(1)}`, `${MARKER}${MARKER}`, `é${MARKER}`, `\u{1f600}${MARKER}`, `\ud800${MARKER}`, `${MARKER}\ud800`, `\0${MARKER}`, `${MARKER}\0`,
      '<!-- m7-managed ->', '<!-- m7-managed --', '<!- m7-managed -->', '<!-- m7-manage -->', '<!-- m7-managedd -->',
    ];
    contents.forEach((c, i) => {
      same('hasManagedMarker(string)', i, c, sw.hasManagedMarker(c), legacySw.hasManagedMarker(c));
      same('hasManagedMarker(Buffer)', i, c, sw.hasManagedMarker(Buffer.from(c, 'utf8')), legacySw.hasManagedMarker(Buffer.from(c, 'utf8')));
    });
    count('markerHand', contents.length * 2);
  });

  it('equal when the marker starts at every place from byte 4040 to 4120: the window ends at byte 4096', () => {
    let n = 0;
    for (let start = 4040; start <= 4120; start++) {
      const content = `${'a'.repeat(start)}${MARKER}${'b'.repeat(50)}`;
      const got = sw.hasManagedMarker(content);
      same('hasManagedMarker', start, `marker at ${start}`, got, legacySw.hasManagedMarker(content));
      same('hasManagedMarker(Buffer)', start, `marker at ${start}`, sw.hasManagedMarker(Buffer.from(content)), legacySw.hasManagedMarker(Buffer.from(content)));
      assert.equal(got, start + 19 <= 4096, `a marker at byte ${start} ends at byte ${start + 19}`);
      n += 2;
    }
    count('markerWindow', n);
  });

  it('a marker that crosses byte 4096 is not found, one that ends exactly at byte 4096 is, also behind multi-byte characters', () => {
    const crossing = `${'a'.repeat(4096 - 10)}${MARKER}`;
    const ending = `${'a'.repeat(4096 - 19)}${MARKER}`;
    const startsAfter = `${'a'.repeat(4096)}${MARKER}`;
    assert.equal(sw.hasManagedMarker(crossing), false);
    assert.equal(sw.hasManagedMarker(ending), true);
    assert.equal(sw.hasManagedMarker(startsAfter), false);
    for (const unit of ['é', '中', '\u{1f600}']) {
      const width = bytes(unit);
      for (let extra = 0; extra < 4; extra++) {
        const pad = unit.repeat(Math.floor((4096 - 19 - extra) / width));
        const content = `${pad}${'a'.repeat(4096 - 19 - bytes(pad))}${MARKER}`;
        assert.equal(bytes(content), 4096, 'a content of exactly 4096 bytes');
        same('hasManagedMarker', extra, content, sw.hasManagedMarker(content), legacySw.hasManagedMarker(content));
        assert.equal(sw.hasManagedMarker(content), true);
        const moved = `${unit}${content}`;
        same('hasManagedMarker (pushed past the window)', extra, moved, sw.hasManagedMarker(moved), legacySw.hasManagedMarker(moved));
        assert.equal(sw.hasManagedMarker(moved), false);
      }
    }
  });

  it('the answer does not depend on what an earlier call left in the buffer', () => {
    assert.equal(sw.hasManagedMarker(`${'a'.repeat(100)}${MARKER}`), true);
    assert.equal(sw.hasManagedMarker('a'.repeat(30)), false, 'a shorter text must not see the marker of the call before');
    assert.equal(sw.hasManagedMarker(`${MARKER.slice(0, 10)}`), false);
    assert.equal(sw.hasManagedMarker(''), false);
  });

  it('equal on a Buffer that is a view with an offset', () => {
    const big = Buffer.from(`xxxx${MARKER}yyyy`);
    const view = big.subarray(4);
    const cut = big.subarray(4, 4 + 18);
    assert.equal(sw.hasManagedMarker(view), legacySw.hasManagedMarker(view));
    assert.equal(sw.hasManagedMarker(view), true);
    assert.equal(sw.hasManagedMarker(cut), legacySw.hasManagedMarker(cut));
    assert.equal(sw.hasManagedMarker(cut), false);
  });

  it(`equal on ${N_RANDOM} seeded contents: text, marker, near-markers and multi-byte characters, up to 6000 bytes`, T, () => {
    const rnd = mulberry32(SEED);
    const pieces = [MARKER.slice(0, 10), MARKER.slice(5), '<!--', '-->', ' m7-managed ', 'm7', '\n', ' ', 'text', 'é', '中', '\u{1f600}', '<!-- m7-managed ->', '<!-- M7-managed -->'];
    let found = 0;
    for (let i = 0; i < N_RANDOM; i++) {
      let c = '';
      const target = below(rnd, 6000);
      while (c.length < target) c += rnd() < 0.7 ? 'abcdef  \n'.charAt(below(rnd, 9)).repeat(1 + below(rnd, 40)) : pick(rnd, pieces);
      if (rnd() < 0.5) {
        const at = rnd() < 0.5 ? Math.max(0, 4096 - 19 - 30 + below(rnd, 60)) : below(rnd, c.length + 1);
        c = `${c.slice(0, at)}${MARKER}${c.slice(at)}`;
      }
      const want = legacySw.hasManagedMarker(c);
      same('hasManagedMarker', i, c, sw.hasManagedMarker(c), want);
      if (want) found++;
    }
    assert.ok(found > 10_000 && found < N_RANDOM - 10_000, `[seed ${SEED}] the generator must hit both answers: ${found} found`);
    count('markerSeeded', N_RANDOM);
    count('markerSeededFound', found);
  });

  it('equal on very large contents (the window is the first 4096 bytes)', () => {
    const large = `${MARKER}${'z'.repeat(5_000_000)}`;
    const late = `${'z'.repeat(5_000_000)}${MARKER}`;
    same('large', 0, 'marker first', sw.hasManagedMarker(large), legacySw.hasManagedMarker(large));
    same('late', 0, 'marker last', sw.hasManagedMarker(late), legacySw.hasManagedMarker(late));
    assert.equal(sw.hasManagedMarker(large), true);
    assert.equal(sw.hasManagedMarker(late), false);
  });
});

describe('managedStateOf, managedWriteAction and managedSyncAction against the old safeWrite.ts', () => {
  it('managedStateOf equals the old one for a missing file, a managed head, a foreign head and an empty head', () => {
    const heads = [null, Buffer.from(''), Buffer.from('plain'), Buffer.from(MARKER), Buffer.from(`# t\n${MARKER}\n`), Buffer.alloc(4096, 97), Buffer.concat([Buffer.alloc(4077, 97), Buffer.from(MARKER)]), Buffer.concat([Buffer.alloc(4078, 97), Buffer.from(MARKER)])];
    heads.forEach((h, i) => same('managedStateOf', i, h && h.toString('latin1').slice(0, 40), sw.managedStateOf(h), legacySw.managedStateOf(h)));
    assert.deepEqual(heads.map(h => sw.managedStateOf(h)), ['absent', 'foreign', 'foreign', 'managed', 'managed', 'foreign', 'managed', 'foreign']);
    count('managedState', heads.length);
  });

  it('managedWriteAction and managedSyncAction equal the old ones for all three states', () => {
    for (const state of ['absent', 'managed', 'foreign']) {
      same('managedWriteAction', 0, state, sw.managedWriteAction(state), legacySw.managedWriteAction(state));
      same('managedSyncAction', 0, state, sw.managedSyncAction(state), legacySw.managedSyncAction(state));
    }
    assert.equal(sw.managedWriteAction('absent'), 'create');
    assert.equal(sw.managedWriteAction('managed'), 'update');
    assert.equal(sw.managedWriteAction('foreign'), 'skip');
    assert.equal(sw.managedSyncAction('absent'), 'skip');
    assert.equal(sw.managedSyncAction('managed'), 'sync');
    assert.equal(sw.managedSyncAction('foreign'), 'skip');
    count('managedAction', 6);
  });

  it('a state that is none of the three is skipped, as before', () => {
    for (const state of ['', 'MANAGED', 'other', undefined, null, 7]) {
      same('managedWriteAction', 0, state, sw.managedWriteAction(state), legacySw.managedWriteAction(state));
      same('managedSyncAction', 0, state, sw.managedSyncAction(state), legacySw.managedSyncAction(state));
    }
  });
});

// ---------------------------------------------------------------------------
// init_project
// ---------------------------------------------------------------------------

describe('isEmptyListing and needsInitNoteFor against the old initProject.ts', () => {
  const IGNORED = legacyIp.NOT_PROJECT_FILES;

  it('the ignored names are the old four', () => {
    assert.deepEqual(IGNORED, ['.git', '.gitignore', '.DS_Store', '.m7']);
  });

  it('isEmptyListing equals the old one for every list of up to six names over the four ignored names and one other', () => {
    const alphabet = [...IGNORED, 'x'];
    let level = [[]];
    let n = 0;
    for (let len = 0; len <= 6; len++) {
      for (const names of level) { same('isEmptyListing', n++, names, ip.isEmptyListing(names), legacyIp.isEmptyListing(names)); }
      level = level.flatMap(list => alphabet.map(a => [...list, a]));
    }
    count('listingExhaustive', n);
  });

  it('isEmptyListing equals the old one for near misses of the four names, and the answers are the expected ones', () => {
    const near = ['.GIT', '.Git', '.git ', ' .git', '.git.', 'git', '.gitignore2', '.gitmodules', '.gitattributes', '.ds_store', '.DS_store', '.DS_Store ', '.DS_Store\0', '.m7x', '.m', '.m77', 'm7', '', ' ', '.', '..', '.github', '.vscode', '.env', '.cursorrules', 'package.json', 'K', '.gİt', '.ſit', '.git\0', '\0', '.git\0.git', '.git\0.m7', '.git/', '/.git', '.gi̇t'];
    near.forEach((name, i) => {
      same('isEmptyListing([name])', i, name, ip.isEmptyListing([name]), legacyIp.isEmptyListing([name]));
      same('isEmptyListing(.git + name)', i, name, ip.isEmptyListing(['.git', name]), legacyIp.isEmptyListing(['.git', name]));
      same('isEmptyListing(name + .m7)', i, name, ip.isEmptyListing([name, '.m7']), legacyIp.isEmptyListing([name, '.m7']));
    });
    assert.equal(ip.isEmptyListing([]), true);
    assert.equal(ip.isEmptyListing(['.git', '.gitignore', '.DS_Store', '.m7']), true);
    assert.equal(ip.isEmptyListing(['.git', '.github']), false);
    assert.equal(ip.isEmptyListing(['.git\0.git']), false, 'a NUL inside one name must not split it into two ignored names');
    count('listingNearMiss', near.length * 3);
  });

  it('every single character 0..255 as a name, and as the end of a name, equals the old answer', () => {
    let n = 0;
    for (let c = 0; c < 256; c++) {
      const ch = String.fromCharCode(c);
      for (const name of [ch, `.git${ch}`, `${ch}.git`, `.m${ch}`, `.${ch}it`]) { same('isEmptyListing', n, name, ip.isEmptyListing([name]), legacyIp.isEmptyListing([name])); n++; }
    }
    count('listingChars', n);
  });

  it(`isEmptyListing equals the old one on ${N_RANDOM} seeded lists`, T, () => {
    const rnd = mulberry32(SEED + 1);
    const names = [...IGNORED, ...IGNORED, ...IGNORED, '.gitmodules', '.GIT', 'src', '.env', '', '.DS_Store ', 'a'.repeat(300), 'é', '.git\0', '.m7\0x'];
    let empty = 0;
    for (let i = 0; i < N_RANDOM; i++) {
      const list = Array.from({ length: below(rnd, 12) }, () => pick(rnd, names));
      const want = legacyIp.isEmptyListing(list);
      same('isEmptyListing', i, list, ip.isEmptyListing(list), want);
      if (want) empty++;
    }
    assert.ok(empty > 3000 && empty < N_RANDOM - 3000, `[seed ${SEED}] the generator must hit both answers: ${empty} empty`);
    count('listingSeeded', N_RANDOM);
    count('listingSeededEmpty', empty);
  });

  it('needsInitNoteFor equals the old one for all eight combinations', () => {
    for (let m = 0; m < 8; m++) {
      const state = { isEmpty: !!(m & 1), hasMemoryBank: !!(m & 2), hasCursorRules: !!(m & 4) };
      same('needsInitNoteFor', m, state, ip.needsInitNoteFor(state), legacyIp.needsInitNoteFor(state));
    }
    assert.equal(ip.needsInitNoteFor({ isEmpty: false, hasMemoryBank: false, hasCursorRules: false }), true);
    count('initNote', 8);
  });
});

// ---------------------------------------------------------------------------
// Sampling and remote classification
// ---------------------------------------------------------------------------

const MODELS = [
  'claude-opus-4', 'claude-opus-4-1-20250805', 'claude-opus-', 'claude-opus', 'claude-opu', 'claude-sonnet-4', 'claude-3-5-haiku', 'claude-3-opus-20240229', 'gpt-4o', 'Claude-Opus-4', 'CLAUDE-OPUS-4',
  ' claude-opus-4', 'claude-opus-\0', 'claude_opus_4', 'claude-opus‑', 'claude‑opus-4', '', ' ', '-', 'opus', 'claude-opus-4\n', 'claude-opuş-4', 'Klaude-opus-4', 'claude-opus-\u{1f600}',
];

describe('modelTakesTemperature against the old anthropicParams.ts', () => {
  it('equal on the hand-written model names', () => {
    MODELS.forEach((m, i) => same('modelTakesTemperature', i, m, ap.modelTakesTemperature(m), legacyAp.modelTakesTemperature(m)));
    assert.equal(ap.modelTakesTemperature('claude-opus-4'), false);
    assert.equal(ap.modelTakesTemperature('claude-sonnet-4'), true);
    assert.deepEqual(ap.anthropicSampling('claude-opus-4', 0.1), {});
    assert.deepEqual(ap.anthropicSampling('claude-sonnet-4', 0.1), { temperature: 0.1 });
    count('model', MODELS.length);
  });

  it('equal when one character of every value 0..255 stands at each position of the prefix', () => {
    let n = 0;
    for (let c = 0; c < 256; c++) {
      const ch = String.fromCharCode(c);
      const base = 'claude-opus-4';
      for (let i = 0; i <= base.length; i++) {
        for (const m of [`${base.slice(0, i)}${ch}${base.slice(i)}`, `${base.slice(0, i)}${ch}${base.slice(i + 1)}`]) { same('modelTakesTemperature', n, m, ap.modelTakesTemperature(m), legacyAp.modelTakesTemperature(m)); n++; }
      }
    }
    count('modelChars', n);
  });

  it(`equal on ${N_RANDOM} seeded names`, T, () => {
    const rnd = mulberry32(SEED + 2);
    const pool = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. ./\0'].concat(['é', 'K', '中']);
    let opus = 0;
    for (let i = 0; i < N_RANDOM; i++) {
      const chars = [...(rnd() < 0.6 ? pick(rnd, MODELS) : '')];
      for (let k = below(rnd, 4); k > 0; k--) {
        const at = below(rnd, chars.length + 1);
        if (rnd() < 0.4) chars.splice(at, 1);
        else chars.splice(at, rnd() < 0.5 ? 0 : 1, pick(rnd, pool));
      }
      const m = chars.join('');
      const want = legacyAp.modelTakesTemperature(m);
      same('modelTakesTemperature', i, m, ap.modelTakesTemperature(m), want);
      if (!want) opus++;
    }
    assert.ok(opus > 3000, `[seed ${SEED}] the generator must hit Opus names: ${opus}`);
    count('modelSeeded', N_RANDOM);
  });

  it('equal at the length limit: names of 255, 256 and 257 bytes, with and without the Opus prefix', () => {
    let n = 0;
    for (const size of [255, 256, 257]) {
      for (const prefix of ['', 'claude-opus-', 'claude-sonnet-']) {
        const m = `${prefix}${'x'.repeat(size - prefix.length)}`;
        assert.equal(bytes(m), size);
        const got = ap.modelTakesTemperature(m);
        if (size <= 256 || prefix === 'claude-opus-') same('modelTakesTemperature', size, `${prefix}...${size}`, got, legacyAp.modelTakesTemperature(m));
        n++;
      }
    }
    assert.equal(ap.modelTakesTemperature('x'.repeat(256)), true);
    count('modelLengths', n);
  });
});

describe('isRemoteClassificationEnabled against the old intentClassifier.ts', () => {
  const key = 'M7_ALLOW_REMOTE_CLASSIFICATION';

  it('equal on the hand-written values, as the environment variable', () => {
    const values = ['true', 'TRUE', 'True', 'true ', ' true', 'truee', 'tru', 't', '', ' ', '1', 'yes', 'false', '0', 'on', 'true\n', 'true\0', '\0true', 'truе', 'тrue', 'trüe', 'Krue', undefined];
    values.forEach((v, i) => {
      const env = v === undefined ? {} : { [key]: v };
      same('isRemoteClassificationEnabled', i, v, ic.isRemoteClassificationEnabled(env), legacyIc.isRemoteClassificationEnabled(env));
    });
    assert.equal(ic.isRemoteClassificationEnabled({ [key]: 'true' }), true);
    assert.equal(ic.isRemoteClassificationEnabled({}), false);
    count('remote', values.length);
  });

  it('reads process.env when no environment is given, on every call', () => {
    const saved = process.env[key];
    try {
      delete process.env[key];
      assert.equal(ic.isRemoteClassificationEnabled(), false);
      process.env[key] = 'true';
      assert.equal(ic.isRemoteClassificationEnabled(), true);
      process.env[key] = 'TRUE';
      assert.equal(ic.isRemoteClassificationEnabled(), false);
      assert.equal(ic.isRemoteClassificationEnabled(), legacyIc.isRemoteClassificationEnabled());
    } finally {
      if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    }
  });

  it('equal when one character of every value 0..255 stands at each position of "true", and for seeded values', () => {
    let n = 0;
    for (let c = 0; c < 256; c++) {
      const ch = String.fromCharCode(c);
      for (let i = 0; i <= 4; i++) {
        for (const v of [`${'true'.slice(0, i)}${ch}${'true'.slice(i)}`, `${'true'.slice(0, i)}${ch}${'true'.slice(i + 1)}`]) {
          same('isRemoteClassificationEnabled', n, v, ic.isRemoteClassificationEnabled({ [key]: v }), legacyIc.isRemoteClassificationEnabled({ [key]: v }));
          n++;
        }
      }
    }
    const rnd = mulberry32(SEED + 3);
    for (let i = 0; i < 20_000; i++) {
      const v = rnd() < 0.5 ? pick(rnd, ['true', 'TRUE', 'True', 'tRue', 'trUE']) : Array.from({ length: below(rnd, 7) }, () => pick(rnd, [...'truefalsTRUEFALS01 ', 'т', '\0'])).join('');
      same('isRemoteClassificationEnabled', n, v, ic.isRemoteClassificationEnabled({ [key]: v }), legacyIc.isRemoteClassificationEnabled({ [key]: v })); n++;
    }
    count('remoteChars', n);
  });

  it('equal at the length limit: values of 255, 256 and 257 bytes starting with "true"', () => {
    for (const size of [255, 256, 257]) {
      const v = `true${' '.repeat(size - 4)}`;
      same('isRemoteClassificationEnabled', size, `true + ${size - 4} spaces`, ic.isRemoteClassificationEnabled({ [key]: v }), legacyIc.isRemoteClassificationEnabled({ [key]: v }));
    }
  });
});

// ---------------------------------------------------------------------------
// New behaviour: limits, unwritable text, a failing backend
// ---------------------------------------------------------------------------

describe('New behaviour: limits, unwritable text and a failing backend', () => {
  it('an over-long model name takes no temperature (the oracle said yes for a name that is not Opus)', () => {
    const long = `claude-sonnet-${'x'.repeat(300)}`;
    assert.equal(legacyAp.modelTakesTemperature(long), true, 'the oracle');
    assert.equal(ap.modelTakesTemperature(long), false);
    assert.equal(ap.modelTakesTemperature('x'.repeat(257)), false);
    assert.equal(ap.modelTakesTemperature('x'.repeat(256)), true);
    assert.deepEqual(ap.anthropicSampling(long, 0.1), {});
    assert.equal(ap.modelTakesTemperature('claude-opus-4\ud800'), false, 'a lone surrogate cannot be written as UTF-8');
    assert.equal(legacyAp.modelTakesTemperature('claude-sonnet-4\ud800'), true);
    assert.equal(ap.modelTakesTemperature('claude-sonnet-4\ud800'), false);
  });

  it('an over-long listing is not empty (the oracle said empty for as many ignored names as you like)', () => {
    // Each name counts with the NUL byte that ends it: ".git" is 5 bytes, ".m7" is 4.
    const joinedBytes = names => names.reduce((total, name) => total + name.length + 1, 0);
    const inside = [Array(13_107).fill('.git'), [...Array(13_104).fill('.git'), ...Array(4).fill('.m7')]];
    assert.deepEqual(inside.map(joinedBytes), [65_535, 65_536]);
    for (const names of inside) {
      assert.equal(legacyIp.isEmptyListing(names), true);
      assert.equal(ip.isEmptyListing(names), true, `${joinedBytes(names)} bytes: inside the limit`);
    }
    const over = [[...Array(13_101).fill('.git'), ...Array(8).fill('.m7')], Array(13_108).fill('.git'), Array(200_000).fill('.git')];
    assert.deepEqual(over.map(joinedBytes), [65_537, 65_540, 1_000_000]);
    for (const names of over) {
      assert.equal(legacyIp.isEmptyListing(names), true, 'the oracle');
      assert.equal(ip.isEmptyListing(names), false, `${joinedBytes(names)} bytes: over the limit`);
    }
    assert.equal(ip.isEmptyListing(Array(2_000_000).fill('.git')), false, 'two million names stop at the limit and do not grow memory');
  });

  it('a name with a lone surrogate or a NUL byte is a project file; a lone surrogate is refused, as it is no ignored name', () => {
    assert.equal(ip.isEmptyListing(['.git', '\ud800']), false);
    assert.equal(legacyIp.isEmptyListing(['.git', '\ud800']), false);
    assert.equal(ip.isEmptyListing(['.git\0.git']), false);
  });

  it('a value of 257 bytes is not remote classification, a value that cannot be written is not either', () => {
    assert.equal(ic.isRemoteClassificationEnabled({ M7_ALLOW_REMOTE_CLASSIFICATION: `true${' '.repeat(300)}` }), false);
    assert.equal(ic.isRemoteClassificationEnabled({ M7_ALLOW_REMOTE_CLASSIFICATION: 'true\ud800' }), false);
  });

  it('a failing backend gives the refusing value of each rule', () => {
    assert.equal(under(brokenRules(), () => sw.hasManagedMarker(MARKER)), false);
    assert.equal(under(brokenRules(), () => sw.managedStateOf(Buffer.from(MARKER))), 'foreign');
    assert.equal(under(brokenRules(), () => sw.managedStateOf(null)), 'foreign', 'a missing file is "foreign" too when the rules fail, so nothing is created');
    assert.equal(under(brokenRules(), () => sw.managedWriteAction('absent')), 'skip');
    assert.equal(under(brokenRules(), () => sw.managedWriteAction('managed')), 'skip');
    assert.equal(under(brokenRules(), () => sw.managedSyncAction('managed')), 'skip');
    assert.equal(under(brokenRules(), () => ip.isEmptyListing([])), false);
    assert.equal(under(brokenRules(), () => ip.isEmptyListing(['.git'])), false);
    assert.equal(under(brokenRules(), () => ip.needsInitNoteFor({ isEmpty: false, hasMemoryBank: false, hasCursorRules: false })), false);
    assert.equal(under(brokenRules(), () => ap.modelTakesTemperature('claude-sonnet-4')), false);
    assert.deepEqual(under(brokenRules(), () => ap.anthropicSampling('claude-sonnet-4', 0.1)), {});
    assert.equal(under(brokenRules(), () => ic.isRemoteClassificationEnabled({ M7_ALLOW_REMOTE_CLASSIFICATION: 'true' })), false);
  });

  it('a backend that answers a code the facade does not know is a failure too', () => {
    assert.equal(under(brokenRules({ po_managed_state: () => 9 }), () => sw.managedStateOf(Buffer.from(MARKER))), 'foreign', 'the right answer is managed');
    assert.equal(under(brokenRules({ po_managed_state: () => -1 }), () => sw.managedStateOf(null)), 'foreign', 'the right answer is absent');
    assert.equal(under(brokenRules({ po_write_action: () => 9 }), () => sw.managedWriteAction('absent')), 'skip', 'the right answer is create');
    assert.equal(under(brokenRules({ po_write_action: () => -1 }), () => sw.managedWriteAction('managed')), 'skip', 'the right answer is update');
    assert.equal(under(brokenRules({ po_sync_action: () => 5 }), () => sw.managedSyncAction('managed')), 'skip', 'the right answer is sync');
    assert.equal(under(brokenRules({ po_has_marker: () => 2 }), () => sw.hasManagedMarker(MARKER)), false, 'a bool must be exactly 0 or 1');
    assert.equal(under(brokenRules({ po_listing_empty: () => 3 }), () => ip.isEmptyListing([])), false, 'the right answer is true');
    assert.equal(under(brokenRules({ po_needs_init_note: () => 2 }), () => ip.needsInitNoteFor({ isEmpty: false, hasMemoryBank: false, hasCursorRules: false })), false, 'the right answer is true');
    assert.equal(under(brokenRules({ po_model_takes_temperature: () => 2 }), () => ap.modelTakesTemperature('claude-sonnet-4')), false, 'the right answer is true');
    assert.equal(under(brokenRules({ po_remote_classification: () => 2 }), () => ic.isRemoteClassificationEnabled({ M7_ALLOW_REMOTE_CLASSIFICATION: 'true' })), false, 'the right answer is true');
  });

  it('a backend that traps once does not poison the next call: the instance is replaced', () => {
    assert.equal(under(brokenRules(), () => sw.hasManagedMarker(MARKER)), false);
    assert.equal(sw.hasManagedMarker(MARKER), true);
    assert.equal(sw.managedStateOf(null), 'absent');
    assert.equal(ip.isEmptyListing(['.git']), true);
  });
});

// ---------------------------------------------------------------------------
// The old code is gone from the sources
// ---------------------------------------------------------------------------

describe('The decisions left the TypeScript', () => {
  it('safeWrite.ts, initProject.ts, anthropicParams.ts and intentClassifier.ts no longer hold the comparisons', async () => {
    const { readFileSync } = await import('node:fs');
    const { ROOT } = await import('./helpers/deepScanHarness.mjs');
    const read = rel => readFileSync(`${ROOT}/${rel}`, 'utf8');
    assert.doesNotMatch(read('src/core/utils/safeWrite.ts'), /subarray\(0, MANAGED_SCAN_BYTES\)|state === 'managed'|state === 'absent'/);
    assert.doesNotMatch(read('src/core/tools/initProject.ts'), /NOT_PROJECT_FILES|names\.every|!state\.isEmpty/);
    assert.doesNotMatch(read('src/hive/api/anthropicParams.ts'), /startsWith\('claude-opus-'\)/);
    assert.doesNotMatch(read('src/core/intelligence/intentClassifier.ts'), /=== 'true'/);
    const c = read('src/rules/generated/constants.ts');
    assert.match(c, /export const PO_LIST_MAX = 65536;/);
    assert.match(c, /export const PO_TEXT_MAX = 256;/);
  });
});
