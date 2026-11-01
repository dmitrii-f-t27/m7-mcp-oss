#!/usr/bin/env node
// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Checks the Apache-2.0 section 4(b) change notices of this fork.
 *
 * Run from anywhere: node scripts/check-notices.mjs
 *
 * Fails (exit code 1) when:
 * - a modified or added .ts, .mjs, .sh, .example, .yaml, .md or .gitleaksignore file
 *   lacks its notice line (the one scripts/mark-modified.mjs writes) in the first
 *   two lines;
 * - a modified or added JSON file is not listed in NOTICE;
 * - a shebang is not on line 1;
 * - a changed file has a type with no notice rule;
 * - LICENSE differs from the fork point 0ace0ab.
 *
 * The changed files are the same set as in scripts/mark-modified.mjs. It reads files
 * only and writes nothing. It needs the git history down to 0ace0ab.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = '0ace0ab8e74ec04937161e76f78e446f5ca5da5f';
const MODIFIED = 'Modified by Dmitrii Fedorov, 2026: changed from the original M7 MCP (see NOTICE).';
const ADDED = 'Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).';
const EXEMPT = new Set(['LICENSE', 'NOTICE']);

const git = (args, encoding = 'utf8') => execFileSync('git', args, { cwd: ROOT, encoding, maxBuffer: 64 * 1024 * 1024 });

function changedFiles() {
  const parts = git(['diff', '--no-renames', '-z', '--name-status', BASE]).split('\0');
  const found = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) found.set(parts[i + 1], parts[i][0]);
  for (const f of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (f) found.set(f, 'A');
  }
  return found;
}

function ruleFor(file) {
  if (path.basename(file) === '.gitleaksignore') return 'hash';
  switch (path.extname(file)) {
    case '.ts':
    case '.mjs': return 'slash';
    case '.sh':
    case '.example':
    case '.yaml': return 'hash';
    case '.md': return 'md';
    case '.json': return 'json';
    default: return null;
  }
}

const failures = [];
const noticePath = path.join(ROOT, 'NOTICE');
const noticeLines = existsSync(noticePath) ? readFileSync(noticePath, 'utf8').split('\n').map(l => l.trim()) : null;
if (noticeLines === null) failures.push('NOTICE: file is missing');

let checked = 0;
for (const [file, code] of [...changedFiles()].sort(([a], [b]) => a.localeCompare(b))) {
  if (code === 'D' || EXEMPT.has(file)) continue;
  const rule = ruleFor(file);
  if (rule === null) { failures.push(`${file}: no notice rule for this file type`); continue; }
  checked++;
  if (rule === 'json') {
    if (noticeLines !== null && !noticeLines.includes(file)) failures.push(`${file}: JSON file is not listed in NOTICE`);
    continue;
  }
  const head = readFileSync(path.join(ROOT, file), 'utf8').split('\n').slice(0, 3);
  const prefix = rule === 'slash' ? '// ' : rule === 'hash' ? '# ' : '> ';
  const want = prefix + (code === 'A' ? ADDED : MODIFIED);
  if (!head.slice(0, 2).includes(want)) failures.push(`${file}: first two lines lack the notice "${want}"`);
  const stray = head.findIndex((l, i) => i > 0 && l.startsWith('#!'));
  if (stray !== -1) failures.push(`${file}: shebang is on line ${stray + 1}, not line 1`);
}

const licenseNow = readFileSync(path.join(ROOT, 'LICENSE'));
const licenseBase = git(['show', `${BASE}:LICENSE`], 'buffer');
if (!licenseNow.equals(licenseBase)) failures.push(`LICENSE: differs from ${BASE.slice(0, 7)}`);

if (failures.length > 0) {
  console.error(`check-notices: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-notices: OK, ${checked} changed or added files checked, LICENSE unchanged`);
