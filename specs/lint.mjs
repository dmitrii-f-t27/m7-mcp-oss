#!/usr/bin/env node
// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Lints the t27 specs for what t27c, cc and the wasm build do not catch. Run by specs/generate.sh.
 *
 *   node specs/lint.mjs [root]      root defaults to the repository this file is in
 *
 * Rules (each problem is printed as `file:line: [rule] text`; the exit code is 1 if there is any):
 *   string-non-ascii       a string literal holds a non-ASCII character or `\x` (t27c double-encodes them)
 *   use                    a `use` statement (it splices declarations and clashes in one translation unit)
 *   assert-outside-test    `assert` outside a `test` block (-DNDEBUG removes it from the wasm)
 *   for / not / while-true a `for` loop, `not x` (use `!x`), or `while (true)`
 *   unguarded-divisor      `/` or `%` whose divisor is not a number or a constant, on a line without `// guarded`
 *   big-local-array        a local array over 64 KiB, or one whose size cannot be read from the text
 *   struct-in-export       an exported function whose signature names a struct of the spec
 *   missing-length-check   an exported function with an array and a `len` parameter whose first statement
 *                          is not an `if` that compares every `len` parameter
 *   exports                a name in specs/exports.txt is not a `pub fn` of any spec
 *   order                  specs/ORDER and the specs/*.t27 files do not name the same specs
 *
 * Comments: `//` to the end of the line, and `;` at the start of a line outside any braces.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOCAL_ARRAY_MAX_BYTES = 64 * 1024;
const TYPE_BYTES = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8 };

/** Blank comments and string contents (same length, newlines kept). Returns the strings and the `//` comment of each line. */
export function mask(text) {
  const out = text.split('');
  const strings = [];
  const comments = new Map();
  let depth = 0;
  let line = 0;
  let atLineStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      line++;
      atLineStart = true;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') { out[j] = ' '; j++; }
      comments.set(line, text.slice(i, j));
      i = j - 1;
      continue;
    }
    if (c === ';' && atLineStart && depth === 0) {
      let j = i;
      while (j < text.length && text[j] !== '\n') { out[j] = ' '; j++; }
      i = j - 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        j++;
      }
      strings.push({ line, text: text.slice(i + 1, Math.min(j, text.length)) });
      for (let k = i + 1; k < j && k < text.length; k++) if (text[k] !== '\n') out[k] = ' ';
      i = j;
      atLineStart = false;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (c !== ' ' && c !== '\t') atLineStart = false;
  }
  return { masked: out.join(''), strings, comments };
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length - 1;

/** Index of the bracket that closes the one at `open`, or -1. */
function matching(text, open, openCh, closeCh) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === openCh) depth++;
    else if (text[i] === closeCh && --depth === 0) return i;
  }
  return -1;
}

function constants(masked) {
  const consts = new Map();
  for (const m of masked.matchAll(/(?:^|\n)[ \t]*(?:pub[ \t]+)?const[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*[A-Za-z0-9_]+[ \t]*=[ \t]*(-?(?:0[xX][0-9a-fA-F]+|\d+))[ \t]*;/g)) {
    consts.set(m[1], Number(m[2]));
  }
  return consts;
}

/** Blocks at brace depth 0: fn, test, struct, enum. */
function blocks(masked) {
  const found = [];
  const re = /(?:^|\n)[ \t]*(?:pub[ \t]+)?(fn|test|struct|enum)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/g;
  let depthAt = 0;
  let scanned = 0;
  for (const m of masked.matchAll(re)) {
    for (; scanned < m.index; scanned++) {
      if (masked[scanned] === '{') depthAt++;
      else if (masked[scanned] === '}') depthAt--;
    }
    if (depthAt !== 0) continue;
    const kind = m[1];
    const nameAt = m.index + m[0].length;
    let params = '';
    let ret = '';
    let from = nameAt;
    if (kind === 'fn') {
      const open = masked.indexOf('(', nameAt);
      const close = open < 0 ? -1 : matching(masked, open, '(', ')');
      if (close < 0) continue;
      params = masked.slice(open + 1, close);
      from = close + 1;
    }
    const brace = masked.indexOf('{', from);
    if (brace < 0) continue;
    if (kind === 'fn') ret = masked.slice(from, brace).replace(/^\s*->\s*/, '').trim();
    const end = matching(masked, brace, '{', '}');
    if (end < 0) continue;
    found.push({
      kind, name: m[2], pub: /(?:^|\n)[ \t]*pub[ \t]/.test(m[0]), params, ret,
      start: m.index, brace, end, body: masked.slice(brace + 1, end),
    });
  }
  return found;
}

function parseParams(params) {
  return params.split(',').map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf(':');
    return { name: p.slice(0, i).trim(), type: p.slice(i + 1).trim() };
  });
}

/**
 * Lint one spec. `exported` is the set of names in specs/exports.txt.
 * Returns [{ line, rule, text }] with 1-based lines.
 */
export function lintSpec(text, { exported = new Set() } = {}) {
  const problems = [];
  const add = (line, rule, msg) => problems.push({ line: line + 1, rule, text: msg });
  const { masked, strings, comments } = mask(text);
  const raw = text.split('\n');
  const consts = constants(masked);
  const all = blocks(masked);
  const tests = all.filter(b => b.kind === 'test');

  for (const s of strings) {
    if (/[^\x00-\x7f]/.test(s.text) || /\\x/.test(s.text)) add(s.line, 'string-non-ascii', 'a string literal holds a non-ASCII character or \\x');
  }
  for (const m of masked.matchAll(/(?:^|\n)[ \t]*use[ \t]+\S/g)) add(lineOf(masked, m.index + (m[0].startsWith('\n') ? 1 : 0)), 'use', '`use` is forbidden: it splices declarations into the importing spec');
  for (const m of masked.matchAll(/\bassert\b/g)) {
    if (!tests.some(t => m.index > t.brace && m.index < t.end)) add(lineOf(masked, m.index), 'assert-outside-test', '`assert` outside a test block is removed by -DNDEBUG');
  }
  for (const m of masked.matchAll(/\bfor\b/g)) add(lineOf(masked, m.index), 'for', 'use a `while` loop, not `for`');
  for (const m of masked.matchAll(/\bnot\b/g)) add(lineOf(masked, m.index), 'not', 'use `!x`, not `not x`');
  for (const m of masked.matchAll(/\bwhile[ \t]*\([ \t]*true[ \t]*\)/g)) add(lineOf(masked, m.index), 'while-true', '`while (true)` has no bound');

  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c !== '/' && c !== '%') continue;
    const rest = masked.slice(i + 1).match(/^[ \t]*(-?)(0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|\()/);
    const operand = rest ? rest[2] : '(';
    const isNumber = /^(0[xX][0-9a-fA-F]+|\d)/.test(operand);
    if (isNumber || consts.has(operand)) continue;
    const line = lineOf(masked, i);
    if (/\/\/\s*guarded\b/.test(comments.get(line) ?? '')) continue;
    add(line, 'unguarded-divisor', `the divisor "${operand === '(' ? '(...)' : operand}" is not a number or a constant; guard it and write "// guarded" on the line`);
  }

  for (const b of all) {
    if (b.kind !== 'fn' && b.kind !== 'test') continue;
    for (const m of b.body.matchAll(/\bvar[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*\[([^\]]*)\]([A-Za-z0-9_]+)/g)) {
      const line = lineOf(masked, b.brace + 1 + m.index);
      const dim = m[2].trim();
      const n = /^\d+$/.test(dim) ? Number(dim) : consts.get(dim);
      if (n === undefined) { add(line, 'big-local-array', `the size "${dim}" of local array ${m[1]} is not a number or a constant`); continue; }
      const bytes = n * (TYPE_BYTES[m[3]] ?? 8);
      if (bytes > LOCAL_ARRAY_MAX_BYTES) add(line, 'big-local-array', `local array ${m[1]} is ${bytes} bytes; keep it at ${LOCAL_ARRAY_MAX_BYTES} or less, or make it global`);
    }
  }

  const structs = new Set(all.filter(b => b.kind === 'struct').map(b => b.name));
  for (const b of all) {
    if (b.kind !== 'fn' || !exported.has(b.name)) continue;
    const startLine = lineOf(masked, b.start + (masked[b.start] === '\n' ? 1 : 0));
    for (const s of structs) {
      if (new RegExp(`\\b${s}\\b`).test(`${b.params} ${b.ret}`)) add(startLine, 'struct-in-export', `exported ${b.name} names struct ${s} in its signature`);
    }
    const params = parseParams(b.params);
    const hasArray = params.some(p => p.type.startsWith('['));
    const lens = params.filter(p => (p.name === 'len' || p.name.endsWith('_len')) && !p.type.startsWith('['));
    if (!hasArray || lens.length === 0) continue;
    const first = b.body.match(/^\s*if[ \t]*\(/);
    const open = first ? b.body.indexOf('(', first.index) : -1;
    const close = open < 0 ? -1 : matching(b.body, open, '(', ')');
    const cond = close < 0 ? '' : b.body.slice(open + 1, close);
    const missing = lens.filter(p => !new RegExp(`\\b${p.name}\\b`).test(cond) || !/[<>]/.test(cond));
    if (!first || missing.length > 0) {
      add(startLine, 'missing-length-check', `exported ${b.name}: the first statement must be an if that compares ${(missing.length ? missing : lens).map(p => p.name).join(', ')}`);
    }
  }
  return problems.sort((a, b) => a.line - b.line);
}

/** Names that the files of `specs/` declare as `pub fn`. */
function pubFns(text) {
  return blocks(mask(text).masked).filter(b => b.kind === 'fn' && b.pub).map(b => b.name);
}

export function readNames(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap(l => l.replace(/#.*/, '').split(/\s+/)).filter(Boolean);
}

/** Lint every spec of `root/specs`. Returns ['file:line: [rule] text', ...] and the spec names. */
export function lintTree(root) {
  const dir = path.join(root, 'specs');
  const order = readNames(path.join(dir, 'ORDER'));
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /\.t27$/.test(f)).map(f => f.slice(0, -4)).sort() : [];
  const exported = new Set(readNames(path.join(dir, 'exports.txt')));
  const problems = [];
  if (order.length === 0) problems.push('specs/ORDER: names no spec');
  if (new Set(order).size !== order.length) problems.push('specs/ORDER: names a spec twice');
  if ([...order].sort().join(' ') !== files.join(' ')) problems.push(`specs/ORDER: [order] names "${[...order].sort().join(' ')}" but specs/*.t27 are "${files.join(' ')}"`);
  const fns = new Set();
  for (const name of files) {
    const text = readFileSync(path.join(dir, `${name}.t27`), 'utf8');
    for (const f of pubFns(text)) fns.add(f);
    for (const p of lintSpec(text, { exported })) problems.push(`specs/${name}.t27:${p.line}: [${p.rule}] ${p.text}`);
  }
  for (const e of exported) if (!fns.has(e)) problems.push(`specs/exports.txt: [exports] ${e} is not a pub fn of any spec`);
  return { problems, specs: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { problems, specs } = lintTree(root);
  for (const p of problems) console.error(p);
  if (problems.length > 0) {
    console.error(`lint: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`lint: ${specs} spec(s) clean`);
}
