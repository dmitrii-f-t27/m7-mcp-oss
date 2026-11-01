// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * The peer-text rules (specs/mesh_rules.t27) against the TypeScript they replace (SEC-7): what stands between
 * text from another workstation and the model.
 *
 * The oracle is the old code, transpiled at commit c41f8ce by scripts/make-oracle.mjs:
 *   tests/oracles/peerTextLegacy.mjs   src/mesh/peerText.ts
 * Every test compares the public functions of dist/mesh/peerText.js with the oracle on the same input.
 * The oracle compared UTF-16 code units and let a lone surrogate pass through; the new rules work on UTF-8, which
 * cannot carry one. So the input goes through `toWellFormed()` before it reaches the oracle, exactly as the new
 * code does it first (tests/sec-mesh.test.mjs states the same change). For well-formed text of up to 3 MiB
 * (3,145,728 bytes) the answers must be equal. The cases under "New behaviour" are the only ones where they differ,
 * and each says why:
 *   - a lone surrogate becomes U+FFFD (sec-mesh.test.mjs:553-555 pins this);
 *   - text of more than 3,145,728 bytes is refused with "[peer text refused: over the size limit]", never cut;
 *   - a failing backend gives "[peer text refused: rules unavailable]", never the raw text; withPeerHeader then adds
 *     the header;
 *   - a `max` that is not a whole number from 0 to 2^31-1 is refused (the oracle compared it as a number).
 *
 * Seed: the random cases use M7_RULES_SEED (default 27). Every failure message starts with the seed and the case
 * number: M7_RULES_SEED=<seed> node --test tests/rulesMesh.test.mjs
 *
 * Run: npm run build && node --test --test-force-exit tests/rulesMesh.test.mjs
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import * as legacy from './oracles/peerTextLegacy.mjs';

const pt = await import('../dist/mesh/peerText.js');
const rules = await import('../dist/rules/wasm.js');

const SEED = Number(process.env.M7_RULES_SEED ?? 27);
const N_RANDOM = 100_000;
const T = { timeout: 110_000 };
const OVER_LIMIT = '[peer text refused: over the size limit]';
const UNAVAILABLE = '[peer text refused: rules unavailable]';
const TEXT_MAX = 3_145_728;
const OUT_MAX = 4_718_608;
const enc = new TextEncoder();
const bytes = s => enc.encode(s).length;
const wf = s => (typeof s === 'string' ? s.toWellFormed() : s);

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
  console.log(`rulesMesh: seed ${SEED}; cases compared with the oracle: ${JSON.stringify(counts)}`);
});

const show = v => (typeof v === 'string' && v.length > 120 ? `${JSON.stringify(v.slice(0, 60))}...(${v.length} characters)` : JSON.stringify(v));
function same(label, i, input, got, want) {
  if (got !== want) {
    assert.fail(`[seed ${SEED}] ${label} case ${i}: input ${show(input)}\n  new:    ${show(got)}\n  oracle: ${show(want)}`);
  }
}

/** All the text functions of peerText with the same input, new against oracle. `max` is for untrusted. */
function compareAll(i, input, max) {
  const o = wf(input);
  same('peerLine', i, input, pt.peerLine(input), legacy.peerLine(o));
  same('peerBlock', i, input, pt.peerBlock(input), legacy.peerBlock(o));
  same(`untrusted max=${max}`, i, input, pt.untrusted(input, max), legacy.untrusted(o, max));
  same('untrustedId', i, input, pt.untrustedId(input), legacy.untrustedId(o));
  same('untrustedBlock', i, input, pt.untrustedBlock(input), legacy.untrustedBlock(o));
}

/** A backend whose functions all throw, except what `override` replaces. memory and the buffer addresses are the real ones. */
function brokenRules(override = {}) {
  const real = rules.callRules(x => x, null);
  assert.ok(real, 'the real rules load');
  return new Proxy({}, {
    get: (_, key) => {
      if (key in override) return override[key];
      if (key === 'memory') return real.memory;
      if (typeof key === 'string' && /^(pr|nr|po|mr)_addr_/.test(key)) return real[key];
      if (key === 'mr_refusal') return real[key];
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

const CONTROLS_AND_EDGES = [
  0x00, 0x08, 0x09, 0x0a, 0x0b, 0x0d, 0x1f, 0x20, 0x3c, 0x3e, 0x7e, 0x7f, 0x80, 0x84, 0x85, 0x86, 0x9f, 0xa0, 0xac, 0xad, 0xae, 0x34e, 0x34f, 0x350, 0x61b, 0x61c, 0x61d,
  0x180d, 0x180e, 0x180f, 0x2009, 0x200a, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2010, 0x2027, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x202f,
  0x205f, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0xfefe, 0xfeff, 0xff00, 0xfff8, 0xfff9, 0xfffa, 0xfffb, 0xfffc, 0xfffd,
  0xffff, 0x10000, 0xdffff, 0xe0000, 0xe0001, 0xe0020, 0xe007e, 0xe007f, 0xe0080, 0xe00ff, 0x10ffff,
];

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

describe('mr_is_control against isControl of the old peerText.ts', () => {
  it('equal for every code point from 0 to 0x10FFFF (the surrogates left out), with and without keepLayout', T, () => {
    const bad = [];
    let n = 0;
    rules.callRules(x => {
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        for (const keep of [false, true]) {
          const got = x.mr_is_control(cp, keep ? 1 : 0);
          const want = legacy.isControl(cp, keep) ? 1 : 0;
          if (got !== want && bad.length < 10) bad.push(`U+${cp.toString(16)} keep=${keep}: ${got} vs ${want}`);
          n++;
        }
      }
      return null;
    }, null);
    assert.deepEqual(bad, [], `[seed ${SEED}] ${bad.join('; ')}`);
    assert.ok(n > 2_000_000, `only ${n} code points were compared: is mr_is_control exported?`);
    count('isControl', n);
  });

  it('peerLine and peerBlock equal the old ones for one character, at every range edge and its neighbours', T, () => {
    const cps = new Set(CONTROLS_AND_EDGES);
    for (let cp = 0; cp < 0x3100; cp++) cps.add(cp);
    for (const edge of CONTROLS_AND_EDGES) for (let d = -40; d <= 40; d++) if (edge + d >= 0 && edge + d <= 0x10ffff) cps.add(edge + d);
    const rnd = mulberry32(SEED);
    for (let i = 0; i < 30_000; i++) cps.add(below(rnd, 0x110000));
    let n = 0;
    for (const cp of cps) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      for (const s of [ch, `x${ch}y`, `<${ch}<`, `${ch}${ch}`]) {
        same('peerLine', n, s, pt.peerLine(s), legacy.peerLine(s));
        same('peerBlock', n, s, pt.peerBlock(s), legacy.peerBlock(s));
        n++;
      }
    }
    count('controlChars', n);
  });
});

// ---------------------------------------------------------------------------
// Seeded text
// ---------------------------------------------------------------------------

const PIECES = [
  'a', 'Z', ' ', '-', '`', 'é', '日', '\u{1f600}', '\u{1f468}', '‍', '\u{e0041}', '\u{e0000}', '\u{e007f}', '\u{e0080}', '\u{10ffff}', '\u{10000}',
  '\n', '\r', '\t', '\u0000', '\u0007', '\u007f', '\u0085', '\u009f', '​', '‎', ' ', ' ', '‮', '⁦', '⁩', '﻿', '­', '͏', '؜', '᠎',
  '⁠', '⁥', '￹', '￻', '￼', '�',
  '<', '>', '<<', '>>', '<<<', '>>>', '<<<<', '>>>>', '<<<<<', '>>>>>', '<<<<<<', '<>', '><', '<<>>', '<<<>>>',
];

function genText(rnd) {
  let s = '';
  const n = below(rnd, 40);
  for (let i = 0; i < n; i++) s += rnd() < 0.7 ? pick(rnd, PIECES) : pick(rnd, PIECES).repeat(1 + below(rnd, 8));
  return s;
}

describe('the text functions against the old peerText.ts', () => {
  it(`equal on ${N_RANDOM} seeded strings with astral characters and runs of < and >, for every function`, T, () => {
    const rnd = mulberry32(SEED + 1);
    const maxes = [undefined, 0, 1, 2, 3, 4, 5, 8, 12, 13, 50, 150, 300, 100000];
    let fenceTexts = 0;
    for (let i = 0; i < N_RANDOM; i++) {
      const s = genText(rnd);
      const max = rnd() < 0.8 ? pick(rnd, maxes) : below(rnd, 60);
      compareAll(i, s, max);
      same('withPeerHeader', i, s, pt.withPeerHeader(s), legacy.withPeerHeader(s));
      if (s.includes('<<<')) fenceTexts++;
    }
    assert.ok(fenceTexts > 5000, `[seed ${SEED}] the generator must hit fences: ${fenceTexts}`);
    count('seededTexts', N_RANDOM);
    count('seededWithFence', fenceTexts);
  });

  it('equal on a value that is not a string: numbers, null, undefined, objects, arrays, booleans', () => {
    const values = [undefined, null, 0, 42, -1.5, NaN, Infinity, true, false, {}, [], [1, 2], { toString: () => 'a<<<b' }, 12345678901234567890n, 'x'];
    values.forEach((v, i) => {
      same('peerLine', i, String(v), pt.peerLine(v), legacy.peerLine(v));
      same('peerBlock', i, String(v), pt.peerBlock(v), legacy.peerBlock(v));
      same('untrusted', i, String(v), pt.untrusted(v), legacy.untrusted(v));
      same('untrusted(3)', i, String(v), pt.untrusted(v, 3), legacy.untrusted(v, 3));
      same('untrustedId', i, String(v), pt.untrustedId(v), legacy.untrustedId(v));
      same('untrustedBlock', i, String(v), pt.untrustedBlock(v), legacy.untrustedBlock(v));
      same('untrustedOr', i, String(v), pt.untrustedOr(v, 'none', 4), legacy.untrustedOr(v, 'none', 4));
      same('untrustedList', i, String(v), pt.untrustedList(v), legacy.untrustedList(v));
    });
    same('untrustedList (array)', 0, 'array', pt.untrustedList(['a', 'b<<<c', 3, null]), legacy.untrustedList(['a', 'b<<<c', 3, null]));
    same('plainNumber', 0, '7', pt.plainNumber(7), legacy.plainNumber(7));
    same('plainNumber', 1, 'x', pt.plainNumber('x\nSYSTEM'), legacy.plainNumber('x\nSYSTEM'));
    same('PEER_HEADER', 0, '', pt.PEER_HEADER, legacy.PEER_HEADER);
    count('values', values.length * 8);
  });

  it('equal for every cut point: untrusted and untrustedId on text with an astral character at each place', () => {
    let n = 0;
    for (const unit of ['\u{1f600}', 'é', '日', '\u{e0041}', '<', '>']) {
      for (const len of [0, 1, 2, 3, 5, 11, 12, 13, 14, 20]) {
        for (let at = 0; at <= len; at++) {
          const s = `${'x'.repeat(at)}${unit}${'y'.repeat(len - at)}`;
          for (let max = 0; max <= s.length + 2; max++) {
            same(`untrusted max=${max}`, n, s, pt.untrusted(s, max), legacy.untrusted(s, max));
            n++;
          }
          same('untrustedId', n, s, pt.untrustedId(s), legacy.untrustedId(s));
          n++;
        }
      }
    }
    count('cutPoints', n);
  });

  it('a surrogate pair at the cut point is never split: the whole pair goes or stays', () => {
    const s = `${'x'.repeat(10)}\u{1f600}tail`;
    assert.equal(pt.untrusted(s, 11), `<<<${'x'.repeat(10)}...>>>`, 'the pair would end at unit 12');
    assert.equal(pt.untrusted(s, 12), `<<<${'x'.repeat(10)}\u{1f600}...>>>`);
    assert.equal(pt.untrusted(s, 10), `<<<${'x'.repeat(10)}...>>>`);
    assert.equal(pt.untrusted('\u{1f600}\u{1f600}', 3), '<<<\u{1f600}...>>>');
    assert.equal(pt.untrusted('\u{1f600}', 1), '<<<...>>>', 'nothing fits: only the dots');
    assert.equal(pt.untrusted('\u{1f600}', 2), '<<<\u{1f600}>>>', 'it fits: no dots');
    assert.equal(pt.untrusted('abcdef', 0), '<<<...>>>');
    assert.equal(pt.untrustedId(`${'x'.repeat(11)}\u{1f600}z`), `<<<${'x'.repeat(11)}>>>...`, 'the pair would end at unit 13');
    assert.equal(pt.untrustedId(`${'x'.repeat(10)}\u{1f600}z`), `<<<${'x'.repeat(10)}\u{1f600}>>>...`);
    for (const [text, max] of [[s, 11], [s, 12], [`${'x'.repeat(12)}\u{1f600}`, 12]]) same('untrusted', max, text, pt.untrusted(text, max), legacy.untrusted(text, max));
  });

  it('the marks of the old tests: fences, spaces next to the marks, newlines in a block', () => {
    for (const [s, want] of [['<<<', '<<< << <>>>'], ['>>>', '<<<>> > >>>'], ['<x', '<<< <x>>>'], ['x>', '<<<x> >>>'], ['a\nb', '<<<a b>>>'], ['', '<<<>>>']]) {
      assert.equal(pt.untrusted(s), want);
      same('untrusted', 0, s, pt.untrusted(s), legacy.untrusted(s));
    }
    assert.equal(pt.untrustedBlock('a\nb'), '<<<\na\nb\n>>>');
    assert.equal(pt.untrustedBlock('a\n'), '<<<\na\n>>>');
    assert.equal(pt.untrustedBlock(''), '<<<\n\n>>>');
    assert.equal(pt.untrustedBlock('<<<\n>>>'), '<<<\n<< <\n>> >\n>>>');
    assert.equal(pt.withPeerHeader('no marks'), 'no marks');
    assert.equal(pt.withPeerHeader('has <<<x>>>'), `${pt.PEER_HEADER}\nhas <<<x>>>`);
  });
});

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

describe('text near the limit of 3,145,728 bytes', () => {
  const unitsOf = [['a', 1], ['é', 2], ['日', 3], ['\u{1f600}', 4]];

  it('texts of 3,145,727 and 3,145,728 bytes give the old answers for every function', T, () => {
    let n = 0;
    for (const [unit, width] of unitsOf) {
      const whole = Math.floor(TEXT_MAX / width);
      for (const size of [TEXT_MAX - width, TEXT_MAX]) {
        const s = unit.repeat(Math.floor(size / width));
        assert.ok(bytes(s) <= TEXT_MAX);
        for (const max of [undefined, 150]) compareAll(n++, s, max);
        same('withPeerHeader', n, s, pt.withPeerHeader(s), legacy.withPeerHeader(s));
      }
      assert.equal(bytes(unit.repeat(whole)), TEXT_MAX);
    }
    const ones = 'a'.repeat(TEXT_MAX - 1);
    compareAll(n++, ones, undefined);
    assert.equal(bytes(ones), 3_145_727);
    count('limitInside', n);
  });

  it('a text of 3,145,729 bytes is refused with the over-limit text by every function, and never cut', T, () => {
    const s = 'a'.repeat(TEXT_MAX + 1);
    assert.equal(bytes(s), 3_145_729);
    for (const out of [pt.peerLine(s), pt.peerBlock(s), pt.untrusted(s), pt.untrusted(s, 150), pt.untrustedId(s), pt.untrustedBlock(s)]) {
      assert.equal(out, OVER_LIMIT);
    }
    const wide = '\u{1f600}'.repeat(TEXT_MAX / 4) + 'z';
    assert.equal(pt.peerLine(wide), OVER_LIMIT);
    assert.equal(pt.untrusted(`${'x'.repeat(TEXT_MAX)}y`, 5), OVER_LIMIT, 'also when the caller asks for a cut at 5');
    assert.equal(pt.peerLine('a'.repeat(TEXT_MAX)).length, TEXT_MAX, 'and exactly at the limit it passes');
  });

  it('text over the limit is refused, not cut', () => {
    const s = `${'a'.repeat(TEXT_MAX)}SECRET-TAIL`;
    for (const out of [pt.peerLine(s), pt.peerBlock(s), pt.untrusted(s), pt.untrusted(s, TEXT_MAX), pt.untrustedId(s), pt.untrustedBlock(s)]) {
      assert.equal(out, OVER_LIMIT);
      assert.ok(!out.includes('aaaa') && !out.includes('SECRET'), 'no part of the text comes back');
    }
    assert.equal(pt.untrusted(s, 10), OVER_LIMIT, 'a text over the limit gets no "..." cut either');
    assert.equal(legacy.peerLine(s).length, s.length, 'the oracle had no limit');
  });

  it('a text over the limit has no header-free pass: withPeerHeader adds the header', () => {
    const s = 'a'.repeat(TEXT_MAX + 1);
    assert.equal(legacy.withPeerHeader(s), s);
    assert.equal(pt.withPeerHeader(s), `${pt.PEER_HEADER}\n${s}`, 'the fence cannot be ruled out, so the header goes first');
    const ok = 'a'.repeat(TEXT_MAX);
    assert.equal(pt.withPeerHeader(ok), ok);
  });

  it('the worst case, a text of 3,145,728 angle brackets, fits the output buffer and equals the old answer', T, () => {
    for (const ch of ['<', '>']) {
      const s = ch.repeat(TEXT_MAX);
      const line = pt.peerLine(s);
      assert.notEqual(line, OVER_LIMIT);
      assert.notEqual(line, UNAVAILABLE);
      assert.equal(line.length, TEXT_MAX + Math.floor((TEXT_MAX - 1) / 2), 'one space for every second bracket after the first');
      assert.ok(line.length + 10 <= OUT_MAX, 'the wrapped text fits too');
      same('peerLine', 0, s, line, legacy.peerLine(s));
      same('peerBlock', 0, s, pt.peerBlock(s), legacy.peerBlock(s));
      same('untrusted', 0, s, pt.untrusted(s), legacy.untrusted(s));
      same('untrusted(150)', 0, s, pt.untrusted(s, 150), legacy.untrusted(s, 150));
      same('untrustedId', 0, s, pt.untrustedId(s), legacy.untrustedId(s));
      same('untrustedBlock', 0, s, pt.untrustedBlock(s), legacy.untrustedBlock(s));
    }
    const mixed = '<>'.repeat(TEXT_MAX / 2);
    same('mixed brackets', 0, '<>...', pt.peerLine(mixed), legacy.peerLine(mixed));
    const triple = '<<<>>>'.repeat(TEXT_MAX / 6);
    same('fences', 0, '<<<>>>...', pt.untrustedBlock(triple), legacy.untrustedBlock(triple));
    count('worstCase', 8);
  });

  it('a relay-size body of 1,048,576 three-byte characters passes', T, () => {
    const body = '日'.repeat(1_048_576);
    assert.equal(body.length, 1_048_576, 'what server.ts:52 limits: UTF-16 units');
    assert.equal(bytes(body), TEXT_MAX, 'which can be 3 MiB of UTF-8');
    assert.equal(pt.peerBlock(body), body);
    assert.equal(pt.peerLine(body), body);
    assert.equal(pt.untrusted(body, 150), `<<<${'日'.repeat(150)}...>>>`);
    same('untrustedBlock', 0, '3 MiB', pt.untrustedBlock(body), legacy.untrustedBlock(body));
  });

  it('a call after a long text does not see what is left of it in the buffers', () => {
    pt.peerLine('x'.repeat(100_000));
    assert.equal(pt.peerLine('ab'), 'ab');
    assert.equal(pt.untrusted(''), '<<<>>>');
    assert.equal(pt.untrustedBlock(''), '<<<\n\n>>>');
    assert.equal(pt.withPeerHeader('ab'), 'ab');
    pt.peerLine('<<<'.repeat(1000));
    assert.equal(pt.peerBlock('>'), '>');
  });
});

// ---------------------------------------------------------------------------
// New behaviour
// ---------------------------------------------------------------------------

describe('New behaviour: lone surrogates, bad max, a failing backend', () => {
  it('a lone surrogate becomes U+FFFD in every function, and its neighbour stays', () => {
    for (const s of ['a\ud800b', 'a\udc41b', '\ud800', '\udc00', 'x\ud83d', '\ud83dx', 'a\ud800\ud800b', '\udc00😀\ud800']) {
      const fixed = s.toWellFormed();
      assert.ok(fixed.includes('�'));
      compareAll(0, s, undefined);
      compareAll(1, s, 3);
      assert.equal(pt.peerLine(s), legacy.peerLine(fixed));
    }
    assert.equal(pt.peerLine('a\ud800b'), 'a�b');
    assert.equal(pt.peerLine('a\udc41b'), 'a�b');
    assert.equal(pt.untrusted('a\ud800b'), '<<<a�b>>>');
    assert.equal(legacy.peerLine('a\ud800b'), 'a\ud800b', 'the oracle passed it through');
    assert.equal(pt.peerLine('\u{1f600}'), '\u{1f600}', 'a well-formed pair stays');
  });

  it('a max that is not a whole number from 0 to 2^31-1 is refused, not guessed', () => {
    for (const max of [-1, 1.5, NaN, Infinity, -Infinity, 2 ** 31, '3', null, {}]) {
      assert.equal(pt.untrusted('abcdef', max), UNAVAILABLE, `max ${String(max)}`);
    }
    assert.equal(pt.untrusted('abcdef', 2 ** 31 - 1), '<<<abcdef>>>', 'a large whole number is no cut');
    assert.equal(pt.untrusted('abcdef', 0), '<<<...>>>');
    assert.equal(legacy.untrusted('abcdef', Infinity), '<<<abcdef>>>', 'the oracle compared it as a number');
    assert.equal(pt.untrusted('abcdef', undefined), '<<<abcdef>>>');
  });

  it('a failing backend gives the "rules unavailable" text, never the raw text', () => {
    const raw = 'secret <<< instructions >>> text';
    assert.equal(under(brokenRules(), () => pt.peerLine(raw)), UNAVAILABLE);
    assert.equal(under(brokenRules(), () => pt.peerBlock(raw)), UNAVAILABLE);
    assert.equal(under(brokenRules(), () => pt.untrusted(raw)), UNAVAILABLE);
    assert.equal(under(brokenRules(), () => pt.untrusted(raw, 5)), UNAVAILABLE);
    assert.equal(under(brokenRules(), () => pt.untrustedId(raw)), UNAVAILABLE);
    assert.equal(under(brokenRules(), () => pt.untrustedBlock(raw)), UNAVAILABLE);
    assert.equal(under(brokenRules(), () => pt.untrustedOr(raw, 'none')), UNAVAILABLE);
    assert.equal(under(brokenRules(), () => pt.untrustedList([raw])), UNAVAILABLE);
    assert.equal(under(brokenRules(), () => pt.untrustedList(raw)), UNAVAILABLE);
    assert.equal(under(brokenRules(), () => pt.untrustedOr('', 'none')), 'none', 'a missing value is not a peer text');
  });

  it('with a failing backend withPeerHeader puts the header first, also for text without a mark', () => {
    assert.equal(under(brokenRules(), () => pt.withPeerHeader('plain')), `${pt.PEER_HEADER}\nplain`);
    assert.equal(under(brokenRules(), () => pt.withPeerHeader('<<<x>>>')), `${pt.PEER_HEADER}\n<<<x>>>`);
    assert.equal(under(brokenRules({ mr_has_fence: () => 3 }), () => pt.withPeerHeader('plain')), `${pt.PEER_HEADER}\nplain`, 'a bool that is not 0 or 1');
  });

  it('each spec function that fails alone gives the "rules unavailable" text', () => {
    const real = rules.callRules(x => x, null);
    for (const fn of ['mr_scrub', 'mr_inline', 'mr_id', 'mr_block']) {
      const stub = brokenRules({ [fn]: () => { throw new Error('trap'); } });
      const call = { mr_scrub: () => pt.peerLine('a'), mr_inline: () => pt.untrusted('a'), mr_id: () => pt.untrustedId('a'), mr_block: () => pt.untrustedBlock('a') }[fn];
      assert.equal(under(stub, call), UNAVAILABLE, fn);
    }
    assert.ok(real);
  });

  it('an answer of the backend that makes no sense is a failure: a length past the buffer, minus one, not a number, bytes that are not UTF-8', () => {
    const real = rules.callRules(x => x, null);
    for (const [what, n] of [['past the output buffer', OUT_MAX + 1], ['minus one', -1], ['minus three', -3], ['not a number', NaN], ['a fraction', 1.5]]) {
      assert.equal(under(brokenRules({ mr_scrub: () => n }), () => pt.peerLine('abc')), UNAVAILABLE, what);
    }
    assert.equal(under(brokenRules({ mr_scrub: () => -2 }), () => pt.peerLine('abc')), OVER_LIMIT, 'the limit code gives the over-limit text, from mr_refusal');
    assert.equal(under(brokenRules({ mr_inline: () => -2 }), () => pt.untrusted('abc')), OVER_LIMIT);
    const garbage = brokenRules({ mr_scrub: (_in, _len, _keep, out) => { new Uint8Array(garbage.memory.buffer)[out] = 0xff; return 1; } });
    assert.equal(under(garbage, () => pt.peerLine('abc')), UNAVAILABLE, 'bytes that are not UTF-8');
    assert.equal(under(brokenRules({ mr_refusal: () => OUT_MAX + 5, mr_scrub: () => -2 }), () => pt.peerLine('abc')), UNAVAILABLE, 'a refusal text that does not fit');
  });

  it('a backend that traps once does not poison the next call: the instance is replaced', () => {
    assert.equal(under(brokenRules(), () => pt.peerLine('abc')), UNAVAILABLE);
    assert.equal(pt.peerLine('a\nb'), 'a b');
    assert.equal(pt.untrusted('a<b'), '<<<a<b>>>');
  });
});

// ---------------------------------------------------------------------------
// The old code is gone from the source
// ---------------------------------------------------------------------------

describe('The decisions left the TypeScript', () => {
  it('peerText.ts no longer holds the control list, the scan, the cut or the wrap; the limits are in the generated constants', async () => {
    const { readFileSync } = await import('node:fs');
    const { ROOT } = await import('./helpers/deepScanHarness.mjs');
    const text = readFileSync(`${ROOT}/src/mesh/peerText.ts`, 'utf8');
    assert.doesNotMatch(text, /function isControl|function unitWidth|function scrub|function cutText|function wrapMarked|0x200b|codePointAt|\.includes\('<<<'\)/);
    const c = readFileSync(`${ROOT}/src/rules/generated/constants.ts`, 'utf8');
    assert.match(c, /export const MR_TEXT_MAX = 3145728;/);
    assert.match(c, /export const MR_OUT_MAX = 4718608;/);
  });
});
