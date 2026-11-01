#!/usr/bin/env node
// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Puts the Apache-2.0 section 4(b) change notice into the first lines of every
 * file this fork modified or added, compared with the fork point 0ace0ab.
 *
 * Run from anywhere: node scripts/mark-modified.mjs
 *
 * - Source: git diff --no-renames --name-status 0ace0ab, taken against the working
 *   tree, plus untracked files that git does not ignore (counted as added).
 * - Modified .ts, .mjs, .t27, .c and .h: a "//" line. Modified .sh, .example, .yaml, .tsv,
 *   .txt, .sha256 and the files .gitleaksignore, .gitattributes, T27C_PIN and ORDER: a "#"
 *   line. Modified .md: a "> " line and a blank line, so the notice shows when the page is
 *   rendered.
 * - Added files get the "Added by" text in the same form.
 * - The line goes on line 2 when line 1 is a shebang, otherwise on line 1.
 * - JSON and .wasm files cannot carry a comment. They are listed in NOTICE instead, and
 *   scripts/check-notices.mjs checks that.
 * - Deleted files are not touched. LICENSE and NOTICE are never marked.
 * - Running it twice changes nothing. Exit code 1 if a file has a type with no
 *   rule or carries the notice of the wrong kind.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = '0ace0ab8e74ec04937161e76f78e446f5ca5da5f';
const MODIFIED = 'Modified by Dmitrii Fedorov, 2026: changed from the original M7 MCP (see NOTICE).';
const ADDED = 'Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).';
const EXEMPT = new Set(['LICENSE', 'NOTICE']);
const OURS = /^(\/\/|#|>) (Modified|Added) by Dmitrii Fedorov, 2026/;

const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function changedFiles() {
  const parts = git(['diff', '--no-renames', '-z', '--name-status', BASE]).split('\0');
  const found = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) found.set(parts[i + 1], parts[i][0]);
  for (const f of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (f) found.set(f, 'A');
  }
  return found;
}

const HASH_NAMES = new Set(['.gitleaksignore', '.gitattributes', 'T27C_PIN', 'ORDER']);

function ruleFor(file) {
  if (HASH_NAMES.has(path.basename(file))) return 'hash';
  switch (path.extname(file)) {
    case '.ts':
    case '.mjs':
    case '.t27':
    case '.c':
    case '.h': return 'slash';
    case '.sh':
    case '.example':
    case '.yaml':
    case '.tsv':
    case '.txt':
    case '.sha256': return 'hash';
    case '.md': return 'md';
    case '.json':
    case '.wasm': return 'json';
    default: return null;
  }
}

function noticeLine(rule, status) {
  const text = status === 'A' ? ADDED : MODIFIED;
  return (rule === 'slash' ? '// ' : rule === 'hash' ? '# ' : '> ') + text;
}

const problems = [];
let marked = 0;
let already = 0;
let listed = 0;

for (const [file, code] of [...changedFiles()].sort(([a], [b]) => a.localeCompare(b))) {
  if (code === 'D' || EXEMPT.has(file)) continue;
  if (code !== 'A' && code !== 'M' && code !== 'T') { problems.push(`${file}: unexpected status ${code}`); continue; }
  const status = code === 'A' ? 'A' : 'M';
  const rule = ruleFor(file);
  if (rule === null) { problems.push(`${file}: no notice rule for this file type`); continue; }
  if (rule === 'json') { listed++; continue; }

  const abs = path.join(ROOT, file);
  const lines = readFileSync(abs, 'utf8').split('\n');
  const at = lines[0].startsWith('#!') ? 1 : 0;
  const want = noticeLine(rule, status);
  const here = lines[at] ?? '';
  if (here === want) { already++; continue; }
  if (OURS.test(here)) { problems.push(`${file}: line ${at + 1} carries the wrong notice: ${here}`); continue; }
  lines.splice(at, 0, want, ...(rule === 'md' ? [''] : []));
  writeFileSync(abs, lines.join('\n'));
  marked++;
}

console.log(`mark-modified: ${marked} marked, ${already} already marked, ${listed} files to list in NOTICE (JSON, wasm)`);
if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
