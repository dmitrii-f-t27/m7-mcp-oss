#!/usr/bin/env node
// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Makes an oracle: the TypeScript of a rule as it was at a commit, transpiled to JavaScript. A differential
 * test runs the oracle and the t27 rule on the same inputs and compares the answers.
 *
 *   node scripts/make-oracle.mjs <rev> <src> <out> [--symbols a,b] [--repo <dir>]
 *
 *   rev      a commit as hex, 7 to 40 characters. It is written into the header, because
 *            scripts/measure-t27-share.mjs (MOVED.tsv rule 3) looks for it there.
 *   src      a path in the repository, such as src/core/security/pathGuard.ts
 *   out      the file to write, such as tests/oracles/pathGuardLegacy.mjs
 *   --symbols  keep only these top-level functions, classes and constants, and the top-level declarations of
 *            the same file that they use, and the imports they use. Without it the whole file is kept.
 *            Several source files import heavy modules, so a rule that lives next to them needs --symbols.
 *            An import with a relative path that a kept declaration needs is an error: the oracle lives in
 *            another folder and cannot resolve it.
 *   --repo   the repository (default: the current folder)
 *
 * Output: line 1 is the change notice, line 2 is `// Oracle: <src> at <rev>. Test use only.`, then the
 * JavaScript. The oracle is never loaded by the server.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const NOTICE = '// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).';

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Names a top-level statement declares. */
function declaredNames(st) {
  if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
    return st.name ? [st.name.text] : [];
  }
  if (ts.isVariableStatement(st)) return st.declarationList.declarations.flatMap(d => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  return [];
}

/** Every identifier text in the subtree. */
function identifiers(node) {
  const found = new Set();
  (function walk(n) {
    if (ts.isIdentifier(n)) found.add(n.text);
    ts.forEachChild(n, walk);
  })(node);
  return found;
}

function importedNames(st) {
  const ic = st.importClause;
  if (!ic) return [];
  const names = [];
  if (ic.name) names.push(ic.name.text);
  if (ic.namedBindings && ts.isNamespaceImport(ic.namedBindings)) names.push(ic.namedBindings.name.text);
  if (ic.namedBindings && ts.isNamedImports(ic.namedBindings)) for (const el of ic.namedBindings.elements) names.push(el.name.text);
  return names;
}

/** The source text with only `symbols`, what they use in the same file, and the imports they use. */
export function extractSymbols(text, file, symbols) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaring = new Map();
  for (const st of sf.statements) {
    for (const name of declaredNames(st)) declaring.set(name, [...(declaring.get(name) ?? []), st]);
  }
  for (const s of symbols) {
    if (!declaring.has(s)) throw new Error(`${file}: "${s}" is not a top-level function, class or constant (a method needs its own oracle extraction)`);
  }
  const keep = new Set();
  const queue = symbols.flatMap(s => declaring.get(s));
  while (queue.length > 0) {
    const st = queue.pop();
    if (keep.has(st)) continue;
    keep.add(st);
    for (const id of identifiers(st)) for (const dep of declaring.get(id) ?? []) if (!keep.has(dep)) queue.push(dep);
  }
  const used = new Set();
  for (const st of keep) for (const id of identifiers(st)) used.add(id);
  const parts = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      if (importedNames(st).some(n => used.has(n))) {
        const from = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : '';
        if (from.startsWith('.')) {
          throw new Error(`${file}: a kept declaration needs an import from "${from}"; an oracle cannot resolve a relative import. Keep that rule in the source or change the symbol list`);
        }
        parts.push(st.getText(sf));
      }
      continue;
    }
    if (!keep.has(st)) continue;
    const exported = st.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    const wanted = declaredNames(st).some(n => symbols.includes(n));
    parts.push(wanted && !exported ? `export ${st.getText(sf)}` : st.getText(sf));
  }
  return `${parts.join('\n\n')}\n`;
}

/** The oracle text for `src` at `rev` in `repo`. */
export function makeOracle({ repo = process.cwd(), rev, src, symbols = [] }) {
  if (!/^[0-9a-f]{7,40}$/.test(rev)) throw new Error(`rev must be a commit as 7 to 40 hex characters, got "${rev}"`);
  const text = git(repo, ['show', `${rev}:${src}`]);
  const body = symbols.length > 0 ? extractSymbols(text, src, symbols) : text;
  const js = ts.transpileModule(body, {
    fileName: src,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return `${NOTICE}\n// Oracle: ${src} at ${rev}. Test use only.\n${js}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const positional = [];
    let symbols = [];
    let repo = process.cwd();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--symbols') symbols = (args[++i] ?? '').split(',').filter(Boolean);
      else if (args[i] === '--repo') repo = path.resolve(args[++i] ?? '');
      else if (args[i].startsWith('--')) throw new Error(`unknown option ${args[i]}`);
      else positional.push(args[i]);
    }
    if (positional.length !== 3) throw new Error('usage: make-oracle.mjs <rev> <src> <out> [--symbols a,b] [--repo <dir>]');
    const [rev, src, out] = positional;
    const text = makeOracle({ repo, rev, src, symbols });
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, text);
    console.log(`make-oracle: wrote ${out} (${src} at ${rev}${symbols.length ? `, symbols ${symbols.join(',')}` : ''})`);
  } catch (e) {
    console.error(`make-oracle: ${e.message}`);
    process.exit(2);
  }
}
