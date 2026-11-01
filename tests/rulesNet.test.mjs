// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * The network rules (specs/net_rules.t27) against the TypeScript they replace: which Host and which Origin
 * the visualizer accepts (SEC-6).
 *
 * The oracle is the old code, transpiled at commit c41f8ce by scripts/make-oracle.mjs:
 *   tests/oracles/visualizerRulesLegacy.mjs   src/visualizer/visualizer-server.ts
 * Every test compares isHostAllowed and isOriginAllowed of dist/visualizer/visualizer-server.js with the
 * oracle on the same input. For a port from 0 to 65535 and a text of up to 256 bytes they must agree. The
 * cases under "New behaviour" are the only ones where they may differ, and each says why:
 *   - a port outside 0..65535 (or not a whole number) is refused, also when there is no Origin header;
 *   - a failing backend refuses: the Host, and the Origin, also a request with no Origin header.
 * A text of more than 256 bytes cannot be a loopback name, so the oracle refuses it too; the test shows
 * that the two agree on it.
 *
 * Seed: the random cases use M7_RULES_SEED (default 27). Every failure message starts with the seed and the
 * case number: M7_RULES_SEED=<seed> node --test tests/rulesNet.test.mjs
 *
 * Run: npm run build && node --test --test-force-exit tests/rulesNet.test.mjs
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import * as legacy from './oracles/visualizerRulesLegacy.mjs';

const viz = await import('../dist/visualizer/visualizer-server.js');
const rules = await import('../dist/rules/wasm.js');

const SEED = Number(process.env.M7_RULES_SEED ?? 27);
const N_RANDOM = 100_000;
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
  console.log(`rulesNet: seed ${SEED}; cases compared with the oracle: ${JSON.stringify(counts)}`);
});

function same(label, i, input, got, want) {
  if (got !== want) {
    assert.fail(`[seed ${SEED}] ${label} case ${i}: input ${JSON.stringify(input)}\n  new:    ${JSON.stringify(got)}\n  oracle: ${JSON.stringify(want)}`);
  }
}

/** Both rules for one input; compares the two answers with the oracle. */
function compare(i, text, port) {
  same(`isHostAllowed port ${port}`, i, text, viz.isHostAllowed(text, port), legacy.isHostAllowed(text, port));
  same(`isOriginAllowed port ${port}`, i, text, viz.isOriginAllowed(text, port), legacy.isOriginAllowed(text, port));
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

const PORTS = [0, 1, 80, 443, 3000, 8080, 12345, 65535];
const NAMES = ['127.0.0.1', 'localhost'];

function validHost(name, port) { return `${name}:${port}`; }
function validOrigin(name, port) { return `http://${name}:${port}`; }

// ---------------------------------------------------------------------------
// Hand-written cases
// ---------------------------------------------------------------------------

function handHosts(port) {
  const p = String(port);
  return [
    ...NAMES.flatMap(n => [`${n}:${p}`, `${n.toUpperCase()}:${p}`, `${n[0].toUpperCase()}${n.slice(1)}:${p}`, `${n}:${p}/`, `${n}:${p} `, ` ${n}:${p}`, `${n}:0${p}`, `${n}:+${p}`, `${n}:${p}0`, `${n}:${Number(p) + 1}`, `${n}:`, n, `${n}.:${p}`, `${n}:${p}:${p}`, `x${n}:${p}`, `${n}x:${p}`]),
    '', ':', `:${p}`, `example.com:${p}`, `[::1]:${p}`, `0.0.0.0:${p}`, `127.0.0.2:${p}`, `127.1:${p}`, `2130706433:${p}`, `localhost@evil.com:${p}`, `evil.com#localhost:${p}`,
    `LOCALHOST:${p}`, `LocalHost:${p}`, `lOcAlHoSt:${p}`,
    // look-alike letters: toLowerCase turns the Kelvin sign into k and U+0130 into i + a dot; the long s stays long
    `locahoſt:${p}`, `localhoſt:${p}`, `ſocalhost:${p}`, `\u212Aocalhost:${p}`, `localho\u212At:${p}`, `\u0130ocalhost:${p}`, `localhost\u0130:${p}`, `LOCALHO\u017FT:${p}`,
    `localhost:${p.replace(/\d/g, d => String.fromCharCode(0xff10 + Number(d)))}`, `localhost:${p.replace(/\d/g, d => String.fromCharCode(0x0660 + Number(d)))}`,
    `\uff4cocalhost:${p}`, `localhost\uff1a${p}`, `127\u30fb0.0.1:${p}`, `127.0.0.\u0661:${p}`,
    `localhost\0:${p}`, `\0localhost:${p}`, `local\0host:${p}`, `localhost:${p}\0`,
  ];
}

function handOrigins(port) {
  const p = String(port);
  return [
    ...handHosts(port).map(h => `http://${h}`),
    ...NAMES.flatMap(n => [`HTTP://${n}:${p}`, `Http://${n.toUpperCase()}:${p}`, `https://${n}:${p}`, `http:/${n}:${p}`, `http//${n}:${p}`, `http:///${n}:${p}`, `ws://${n}:${p}`, `${n}:${p}`, `//${n}:${p}`, `http://${n}:${p}/path`, `http://user@${n}:${p}`, `http://${n}:${p}?x=1`, `http://${n}`, `htt\u212A://${n}:${p}`, `http\u017F://${n}:${p}`, `http://${n}:${p}\r\n`]),
    'null', 'NULL', '', ' ', 'file://', 'file:///', 'chrome-extension://abc', 'http://', 'http://:', `http://:${p}`,
  ];
}

describe('isHostAllowed and isOriginAllowed against the old visualizer-server.ts', () => {
  it('equal on the hand-written Host and Origin values, for every port of the list', () => {
    let n = 0;
    for (const port of PORTS) {
      for (const host of handHosts(port)) { compare(n++, host, port); compare(n++, host, port === 80 ? 8080 : 80); }
      for (const origin of handOrigins(port)) { compare(n++, origin, port); compare(n++, origin, port === 80 ? 8080 : 80); }
    }
    count('hand', n);
  });

  it('accept exactly the loopback names with the right port, in any letter case, and refuse the rest', () => {
    for (const port of PORTS) {
      for (const name of NAMES) {
        for (const variant of [name, name.toUpperCase(), `${name[0].toUpperCase()}${name.slice(1)}`]) {
          assert.equal(viz.isHostAllowed(`${variant}:${port}`, port), true, `${variant}:${port}`);
          assert.equal(viz.isOriginAllowed(`http://${variant}:${port}`, port), true, `http://${variant}:${port}`);
          assert.equal(viz.isOriginAllowed(`HTTP://${variant}:${port}`, port), true);
        }
        assert.equal(viz.isHostAllowed(`${name}:${port}`, port === 80 ? 81 : 80), false);
        assert.equal(viz.isOriginAllowed(`http://${name}:${port}`, port === 80 ? 81 : 80), false);
      }
      assert.equal(viz.isHostAllowed(undefined, port), false, 'a missing Host is refused');
      assert.equal(viz.isOriginAllowed(undefined, port), true, 'no Origin header at all is allowed');
      assert.equal(viz.isOriginAllowed('', port), false, 'an empty Origin is refused');
      assert.equal(viz.isOriginAllowed('null', port), false);
    }
  });

  it('the Kelvin sign (U+212A), the dotted capital I (U+0130) and the long s (U+017F) never turn into a loopback name', () => {
    for (const port of [80, 8080, 65535]) {
      for (const lookalike of ['\u212A', '\u0130', '\u017F']) {
        for (const base of [validHost('localhost', port), validHost('127.0.0.1', port)]) {
          for (let i = 0; i <= base.length; i++) {
            for (const candidate of [`${base.slice(0, i)}${lookalike}${base.slice(i)}`, `${base.slice(0, i)}${lookalike}${base.slice(i + 1)}`]) {
              assert.equal(viz.isHostAllowed(candidate, port), legacy.isHostAllowed(candidate, port), JSON.stringify(candidate));
              assert.equal(viz.isHostAllowed(candidate, port), false, JSON.stringify(candidate));
              const origin = `http://${candidate}`;
              assert.equal(viz.isOriginAllowed(origin, port), legacy.isOriginAllowed(origin, port), JSON.stringify(origin));
              assert.equal(viz.isOriginAllowed(origin, port), false, JSON.stringify(origin));
            }
          }
        }
      }
    }
    count('lookalikes', 3 * 3 * 2 * 2 * 25);
  });

  it('equal when one character of every value 0..255 stands at each position of a valid Host and Origin', () => {
    let n = 0;
    for (let c = 0; c < 256; c++) {
      const ch = String.fromCharCode(c);
      for (const base of [validHost('localhost', 8080), validHost('127.0.0.1', 8080), validOrigin('localhost', 8080), validOrigin('127.0.0.1', 8080)]) {
        for (let i = 0; i <= base.length; i++) {
          for (const candidate of [`${base.slice(0, i)}${ch}${base.slice(i)}`, `${base.slice(0, i)}${ch}${base.slice(i + 1)}`]) {
            compare(n++, candidate, 8080);
          }
        }
      }
    }
    count('bytePositions', n);
  });

  it(`equal on ${N_RANDOM} seeded strings: valid values changed in up to three places`, T, () => {
    const rnd = mulberry32(SEED);
    const pool = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:/@-_ []\0'].concat(['\u212A', '\u0130', '\u017F', '\u00e9', '\uff0e', '\u0661', '\u{1f600}', '\uff1a']);
    let accepted = 0;
    for (let i = 0; i < N_RANDOM; i++) {
      const port = pick(rnd, PORTS);
      const text = [...(rnd() < 0.5 ? validHost(pick(rnd, NAMES), port) : validOrigin(pick(rnd, NAMES), port))];
      for (let k = below(rnd, 4); k > 0; k--) {
        const at = below(rnd, text.length + 1);
        switch (below(rnd, 6)) {
          case 0: text.splice(at, 1); break;
          case 1: text.splice(at, 0, pick(rnd, pool)); break;
          case 2: text.splice(at, 1, pick(rnd, pool)); break;
          case 3: if (text[at]) text[at] = text[at] === text[at].toUpperCase() ? text[at].toLowerCase() : text[at].toUpperCase(); break;
          case 4: text.push(...String(pick(rnd, PORTS))); break;
          default: text.splice(at, 0, ...pick(rnd, ['0', '00', ' ', ':', '/', '65536', '+1', '-1']));
        }
      }
      const value = text.join('');
      const usePort = rnd() < 0.7 ? port : pick(rnd, PORTS);
      same('isHostAllowed', i, value, viz.isHostAllowed(value, usePort), legacy.isHostAllowed(value, usePort));
      const o = viz.isOriginAllowed(value, usePort);
      same('isOriginAllowed', i, value, o, legacy.isOriginAllowed(value, usePort));
      if (o) accepted++;
    }
    assert.ok(accepted > 2000, `[seed ${SEED}] the generator must hit accepted values too: ${accepted}`);
    count('random', N_RANDOM);
    count('randomAcceptedOrigins', accepted);
  });

  it('equal at the length limit: texts of 255, 256 and 257 bytes (a loopback name never gets that long, so both refuse)', () => {
    let n = 0;
    for (const size of [255, 256, 257, 1000, 100_000]) {
      for (const filler of ['a', 'A', ' ', '0', '\u00e9']) {
        const unit = bytes(filler);
        const text = filler.repeat(Math.floor(size / unit));
        for (const prefix of ['', 'localhost:8080', 'http://localhost:8080', '127.0.0.1:80']) {
          compare(n++, `${prefix}${text}`, 8080);
          compare(n++, `${text}${prefix}`, 8080);
        }
      }
    }
    for (const size of [255, 256, 257]) {
      const exact = 'a'.repeat(size);
      assert.equal(bytes(exact), size);
      same('isHostAllowed (limit)', size, exact, viz.isHostAllowed(exact, 8080), false);
      same('isOriginAllowed (limit)', size, exact, viz.isOriginAllowed(exact, 8080), false);
    }
    count('lengths', n);
  });

  it('equal for no Origin header at all, for every port of the list', () => {
    for (const port of PORTS) {
      same('isOriginAllowed(undefined)', port, undefined, viz.isOriginAllowed(undefined, port), legacy.isOriginAllowed(undefined, port));
      same('isHostAllowed(undefined)', port, undefined, viz.isHostAllowed(undefined, port), legacy.isHostAllowed(undefined, port));
    }
    count('missingHeader', PORTS.length * 2);
  });

  it('equal for every port from 0 to 65535 on the two valid values', T, () => {
    let n = 0;
    for (let port = 0; port <= 65535; port++) {
      for (const name of NAMES) {
        const host = validHost(name, port);
        if (viz.isHostAllowed(host, port) !== true || viz.isOriginAllowed(`http://${host}`, port) !== true) assert.fail(`${host} must be accepted`);
        if (port < 65535 && (viz.isHostAllowed(host, port + 1) !== false || viz.isHostAllowed(host, port + 1) !== legacy.isHostAllowed(host, port + 1))) assert.fail(`${host} against port ${port + 1}`);
        n += 3;
      }
    }
    count('everyPort', n);
  });
});

// ---------------------------------------------------------------------------
// New behaviour
// ---------------------------------------------------------------------------

describe('New behaviour: ports and a failing backend', () => {
  it('a port outside 0..65535, or not a whole number, is refused, also when there is no Origin header', () => {
    for (const port of [-1, 65536, 70000, 1.5, 0.1, NaN, Infinity, -Infinity, 2 ** 31, 2 ** 53, '8080', null, undefined]) {
      assert.equal(viz.isHostAllowed(`localhost:${port}`, port), false, `Host with port ${String(port)}`);
      assert.equal(viz.isOriginAllowed(`http://localhost:${port}`, port), false, `Origin with port ${String(port)}`);
      assert.equal(viz.isOriginAllowed(undefined, port), false, `no Origin with port ${String(port)}`);
    }
    // the oracle accepted these: it compared the text with the port printed into a string
    assert.equal(legacy.isHostAllowed('localhost:65536', 65536), true);
    assert.equal(legacy.isHostAllowed('localhost:1.5', 1.5), true);
    assert.equal(legacy.isOriginAllowed(undefined, -1), true);
  });

  it('the largest and smallest ports still work', () => {
    assert.equal(viz.isHostAllowed('localhost:0', 0), true);
    assert.equal(viz.isHostAllowed('localhost:65535', 65535), true);
    assert.equal(viz.isOriginAllowed(undefined, 0), true);
    assert.equal(viz.isOriginAllowed(undefined, 65535), true);
  });

  it('a failing backend refuses a Host and an Origin, also a request with no Origin header', () => {
    assert.equal(under(brokenRules(), () => viz.isHostAllowed('localhost:8080', 8080)), false);
    assert.equal(under(brokenRules(), () => viz.isHostAllowed('127.0.0.1:8080', 8080)), false);
    assert.equal(under(brokenRules(), () => viz.isOriginAllowed('http://localhost:8080', 8080)), false);
    assert.equal(under(brokenRules(), () => viz.isOriginAllowed(undefined, 8080)), false, 'no Origin header is allowed only when the rules say so');
    assert.equal(legacy.isOriginAllowed(undefined, 8080), true);
  });

  it('a backend that answers a bool that is not 0 or 1 is a failure too', () => {
    assert.equal(under(brokenRules({ nr_host_allowed: () => 2 }), () => viz.isHostAllowed('localhost:8080', 8080)), false, 'the right answer is true');
    assert.equal(under(brokenRules({ nr_origin_allowed: () => 7 }), () => viz.isOriginAllowed(undefined, 8080)), false, 'the right answer is true');
    assert.equal(under(brokenRules({ nr_origin_allowed: () => -1 }), () => viz.isOriginAllowed('http://localhost:8080', 8080)), false);
  });

  it('a backend that traps once does not poison the next call: the instance is replaced', () => {
    assert.equal(under(brokenRules(), () => viz.isHostAllowed('localhost:8080', 8080)), false);
    assert.equal(viz.isHostAllowed('localhost:8080', 8080), true);
    assert.equal(viz.isOriginAllowed(undefined, 8080), true);
  });

  it('text that cannot be written as UTF-8 (a lone surrogate) is refused; the oracle refused it too, since it is no loopback name', () => {
    for (const text of ['localhost:8080\ud800', '\udc00localhost:8080', 'local\ud83dhost:8080']) {
      assert.equal(viz.isHostAllowed(text, 8080), false);
      assert.equal(viz.isHostAllowed(text, 8080), legacy.isHostAllowed(text, 8080));
      assert.equal(viz.isOriginAllowed(`http://${text}`, 8080), false);
    }
  });
});

// ---------------------------------------------------------------------------
// The old code is gone from the source
// ---------------------------------------------------------------------------

describe('The decisions left the TypeScript', () => {
  it('visualizer-server.ts no longer holds the loopback names or the comparisons', async () => {
    const { readFileSync } = await import('node:fs');
    const { ROOT } = await import('./helpers/deepScanHarness.mjs');
    const text = readFileSync(`${ROOT}/src/visualizer/visualizer-server.ts`, 'utf8');
    assert.doesNotMatch(text, /LOOPBACK_NAMES|toLowerCase|\.some\(/);
    const net = readFileSync(`${ROOT}/src/rules/generated/constants.ts`, 'utf8');
    assert.match(net, /export const NR_TEXT_MAX = 256;/);
  });
});
