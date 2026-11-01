#!/usr/bin/env node
// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * The manifest of the t27 rules: specs/MANIFEST.sha256 lists the SHA-256 of every file the rules wasm is
 * built from or built into, so a hand edit of a spec, a generated header or the wasm shows up in `npm test`
 * without the toolchain.
 *
 *   node scripts/check-rules-manifest.mjs [root]            verify; exit 1 on any problem
 *   node scripts/check-rules-manifest.mjs --write [root]    write specs/MANIFEST.sha256 (specs/generate.sh does this)
 *
 * Files (relative to root, dot files left out): specs/*.t27, specs/ORDER, specs/T27C_PIN, specs/exports.txt,
 * specs/lint.mjs, specs/generate.sh, specs/tables/*, specs/generated/*, specs/wasm/*.c, wasm/m7_rules.wasm and
 * src/rules/generated/constants.ts. The manifest does not list itself.
 *
 * What this cannot prove without the toolchain: that the wasm is what the specs compile to. That is
 * `specs/generate.sh --check`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MANIFEST = 'specs/MANIFEST.sha256';
const NOTICE = '# Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).';
const HEADER = '# SHA-256 of the files the rules wasm is built from and into. Written by specs/generate.sh. Do not edit.';

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Regular, non-dot files of `dir` (not recursive), as relative paths; [] when the folder is missing. */
function filesIn(root, dir, accept = () => true) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter(e => e.isFile() && !e.name.startsWith('.') && accept(e.name))
    .map(e => `${dir}/${e.name}`);
}

/** Files under `dir` at any depth, as relative paths. */
function filesUnder(root, dir) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap(e => {
    if (e.name.startsWith('.')) return [];
    if (e.isDirectory()) return filesUnder(root, `${dir}/${e.name}`);
    return e.isFile() ? [`${dir}/${e.name}`] : [];
  });
}

/** The relative paths the manifest covers that exist under `root`, in byte order. */
export function manifestFiles(root) {
  const files = [
    ...filesIn(root, 'specs', n => n.endsWith('.t27')),
    ...['ORDER', 'T27C_PIN', 'exports.txt', 'lint.mjs', 'generate.sh'].map(n => `specs/${n}`),
    ...filesUnder(root, 'specs/tables'),
    ...filesIn(root, 'specs/generated'),
    ...filesIn(root, 'specs/wasm', n => n.endsWith('.c')),
    'wasm/m7_rules.wasm',
    'src/rules/generated/constants.ts',
  ];
  return [...new Set(files)].filter(f => existsSync(path.join(root, f))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Write specs/MANIFEST.sha256 under `root`. Returns the text. */
export function writeManifest(root) {
  const lines = manifestFiles(root).map(f => `${sha256(path.join(root, f))}  ${f}`);
  const text = `${NOTICE}\n${HEADER}\n${lines.join('\n')}\n`;
  writeFileSync(path.join(root, MANIFEST), text);
  return text;
}

/** Check the files under `root` against specs/MANIFEST.sha256. Returns { ok, problems }. */
export function verifyManifest(root) {
  const problems = [];
  const file = path.join(root, MANIFEST);
  if (!existsSync(file)) return { ok: false, problems: [`${MANIFEST} is missing`] };
  const listed = new Map();
  for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (!m) { problems.push(`${MANIFEST}:${i + 1}: malformed line`); continue; }
    if (listed.has(m[2])) problems.push(`${MANIFEST}:${i + 1}: ${m[2]} is listed twice`);
    listed.set(m[2], m[1]);
  }
  for (const [rel, hash] of listed) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) problems.push(`${rel}: listed in the manifest but missing`);
    else if (sha256(abs) !== hash) problems.push(`${rel}: SHA-256 differs from the manifest`);
  }
  for (const rel of manifestFiles(root)) {
    if (!listed.has(rel)) problems.push(`${rel}: exists but is not in the manifest`);
  }
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const write = args[0] === '--write';
  const root = path.resolve(args[write ? 1 : 0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (write) {
    writeManifest(root);
    console.log(`${MANIFEST}: ${manifestFiles(root).length} files`);
  } else {
    const { ok, problems } = verifyManifest(root);
    for (const p of problems) console.error(p);
    console.log(ok ? `${MANIFEST}: ${manifestFiles(root).length} files match` : `${MANIFEST}: ${problems.length} problem(s)`);
    process.exit(ok ? 0 : 1);
  }
}
