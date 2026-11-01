#!/usr/bin/env node
// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Measures how much of the TypeScript in src/ is boundary, glue, logic, text, data or types,
 * and how many "logic points" it holds. Read-only: it writes no file.
 *
 * Usage:
 *   node scripts/measure-t27-share.mjs [--rev <sha|HEAD|WORKTREE>] [--json]
 *   node scripts/measure-t27-share.mjs --rev c41f8ce --sample 300 --seed 27
 *   node scripts/measure-t27-share.mjs --check-moved [--moved specs/MOVED.tsv]
 *
 * Options:
 *   --rev <x>          Revision to measure; sources are read with `git show <x>:<path>`.
 *                      Default HEAD. WORKTREE reads the files from disk instead: the tracked ones and the
 *                      untracked ones that git does not ignore.
 *   --repo <dir>       Repository to measure. Default: the repository this script is in.
 *   --base-rev <x>     Revision that holds the base logic points. Default c41f8ce (BASE_REV).
 *   --json             Print the numbers as JSON.
 *   --sample N --seed S  Print N classified code lines picked at random (seeded), for a manual audit.
 *   --comment-lines    Diagnostic: also count comment-only lines as code lines (the written rule says no).
 *   --check-moved      Check specs/MOVED.tsv (or --moved <file>) against the rules below. Exit 1 on any failure.
 *
 * Scope: `src/**\/*.ts` files (tracked, and for WORKTREE also untracked and not ignored), minus `__tests__`.
 * `src/rules/wasm.ts`, `src/rules/marshal.ts` and `src/rules/generated/` are boundary by definition and are
 * reported apart, with their code lines and their logic points; those points are not in the denominator and
 * not in the points now. Other facades count as remaining TypeScript, so logic cannot hide in them.
 *
 * A code line is a line with a token other than `} ) ] ; ,`. Comments and blank lines are not code.
 * Each code line gets one class. When several apply, the highest wins:
 *   type      interface, type alias, import, export-from, enum, module, signature, property with no initializer
 *   data      top-level const that is a pure literal tree or rooted at `z.`; `inputSchema` and `description`
 *             properties. A regex literal is logic, so a tree that holds one is not a pure literal tree.
 *   logic     first line of if/switch/case/default/loops; ?: condition; && || ??; other binary operators
 *             except `=`, `,` and `+=`; regex literal; a transform call (map, filter, replace ...)
 *   text      template literal span
 *   boundary  every line of a call or `new` rooted at a host API (fs, path, process, Date, JSON, logger ...,
 *             also a name imported from a host module), or at an SDK, socket or database receiver
 *   glue      everything else
 *
 * A logic point is one non-guard if, ?:, case, loop, &&, || or ??; one regex literal; or one transform
 * call. A guard is an `if` whose condition only tests presence (`x`, `!x`, `a.b`, `x == null`), `typeof`,
 * `err.code` or `instanceof`, alone or joined by && and ||. Guards are counted apart and are not points.
 * ?:, &&, || and ?? are always points: they choose a value, they do not guard a path.
 *
 * Functions are declarations, methods, constructors and accessors with a body, and arrow functions and
 * function expressions bound to a name. A function "has a point" if its body, nested functions included,
 * holds one. A function with a point is effectful if its body calls a host API, awaits, or assigns to a
 * property; otherwise it is pure.
 *
 * The rules are name-based, so they make errors. `--sample` prints lines for a manual audit; the error
 * rate of that audit belongs in docs/T27_BOUNDARY.md. Boundary is a lower bound, and glue is not "free":
 * most of it disappears only when its logic moves.
 *
 * Share: (base points - points now) / base points, where the base points are measured at BASE_REV by
 * this same script, so a change of the rules cannot make the share drift.
 *
 * specs/MOVED.tsv (tab separated, one header line):
 *   spec_fn  source_file  source_symbol  base_rev  oracle_file  test_file
 * A row counts as a moved decision only if all of these hold:
 *   1. `pub fn <spec_fn>` is in a specs/*.t27 file, and <spec_fn> is listed in specs/exports.txt
 *      (names separated by whitespace; `#` starts a comment) or is called by a function that is.
 *   2. <source_symbol> (`name` or `Class.name`) is gone from <source_file>, or holds no logic points.
 *   3. <oracle_file> exists, and its first 30 lines name <source_file> and <base_rev>.
 *   4. <test_file> imports <oracle_file>.
 * A row that fails any rule makes `--check-moved` exit 1. The points moved are summed once per distinct
 * <source_file> and <source_symbol>: two rows on one symbol count its points once.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const K = ts.SyntaxKind;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIR, '..');

/** The revision the share is measured against: the published commit whose README says 0%. */
export const BASE_REV = 'c41f8ce';

/** Classes from the highest priority to the lowest. */
export const CLASSES = ['type', 'data', 'logic', 'text', 'boundary', 'glue'];
const RANK = Object.fromEntries(CLASSES.map((c, i) => [c, CLASSES.length - i]));
const BY_RANK = [null, ...[...CLASSES].reverse()];

/** Files that are boundary by definition (the wasm facade). */
const BOUNDARY_FILE = /^src\/rules\/(wasm\.ts|marshal\.ts|generated\/)/;

export const DEFAULT_OPT = {
  /**
   * Method names of a transform call: `x.name(...)`. The first 19 names, then their siblings (regex and
   * search twins, find and trim variants, flat map). Not in the list: toUpperCase and substring.
   */
  transforms: new Set([
    'map', 'filter', 'reduce', 'replace', 'split', 'slice', 'includes', 'match', 'test', 'sort', 'find', 'some', 'every',
    'join', 'trim', 'toLowerCase', 'startsWith', 'endsWith', 'indexOf',
    'reduceRight', 'replaceAll', 'matchAll', 'exec', 'search', 'findIndex', 'findLast', 'findLastIndex', 'lastIndexOf',
    'trimStart', 'trimEnd', 'flatMap', 'flat',
  ]),
  /** Leftmost names of a call that make it a host API call. */
  hostRoots: new Set([
    'fs', 'fsp', 'path', 'http', 'https', 'process', 'Date', 'JSON', 'Buffer', 'fetch', 'setTimeout', 'setInterval',
    'setImmediate', 'clearTimeout', 'clearInterval', 'crypto', 'child_process', 'log', 'logger', 'createLogger', 'console',
    'yaml', 'YAML', 'WebAssembly', 'os',
  ]),
  /** A name in the receiver chain of a call that makes it a logger, SDK, socket or database call. */
  receiver: /^(client|clients|socket|sockets|ws|wss|db|database|sdk|openai|anthropic|sqlite|stmt|statement|transport|log|logger|console)$/i,
  /** Constructors that are SDK, socket or database calls. */
  ctors: /^(WebSocket|WebSocketServer|Database|OpenAI|Anthropic|Date|Buffer|Worker)$/,
  /** Modules whose imported names are host APIs: a call rooted at such a name is a boundary call. */
  hostModules: /^(node:)?(fs|path|os|http|https|net|url|util|crypto|child_process|zlib|readline|events|stream|worker_threads|perf_hooks|timers|process|dns|tls)(\/.*)?$|^(@anthropic-ai\/sdk|openai|better-sqlite3|ws|yaml|js-yaml|dotenv)(\/.*)?$/,
  /** Also count comment-only lines as code lines (diagnostic; the written rule says no). */
  commentLines: false,
};

// ---------------------------------------------------------------------------
// Reading sources
// ---------------------------------------------------------------------------

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The text of `rel` at `rev` (WORKTREE: from disk), or null when the file is absent. */
export function readAt(repo, rev, rel) {
  try {
    if (rev === 'WORKTREE') return readFileSync(path.join(repo, rel), 'utf8');
    return git(repo, ['show', `${rev}:${rel}`]);
  } catch {
    return null;
  }
}

/** Files under `dir` at `rev`. WORKTREE: tracked files plus untracked files that git does not ignore. */
function listAt(repo, rev, dir) {
  const out = rev === 'WORKTREE'
    ? git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '--', dir])
    : git(repo, ['ls-tree', '-r', '--name-only', rev, '--', dir]);
  return [...new Set(out.split('\n').filter(Boolean))];
}

/** `src/**\/*.ts` at `rev` (see listAt), minus `__tests__`, sorted. */
export function listSources(repo, rev) {
  return listAt(repo, rev, 'src').filter(f => /^src\/.*\.ts$/.test(f) && !f.includes('__tests__')).sort();
}

/** A short name for `rev`, or null when the repository has no such revision. */
export function resolveRev(repo, rev) {
  try {
    if (rev === 'WORKTREE') return `WORKTREE@${git(repo, ['rev-parse', '--short', 'HEAD']).trim()}`;
    return git(repo, ['rev-parse', '--short', `${rev}^{commit}`]).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/** Names along a call target from the leftmost to the last: `this.client.messages.create` gives [this, client, messages, create]. */
function chainNames(expr) {
  const names = [];
  let e = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) {
      names.unshift(e.name.text);
      e = e.expression;
    } else if (ts.isElementAccessExpression(e) || ts.isCallExpression(e) || ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) {
      e = e.expression;
    } else if (ts.isIdentifier(e)) {
      names.unshift(e.text);
      return names;
    } else {
      if (e.kind === K.ThisKeyword) names.unshift('this');
      return names;
    }
  }
}

function stripWrappers(e) {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** A tree of literals only: strings, numbers, booleans, null, undefined, arrays and plain objects of those. A regex is logic, not a literal. */
function isLiteralTree(n) {
  n = stripWrappers(n);
  switch (n.kind) {
    case K.StringLiteral: case K.NumericLiteral: case K.BigIntLiteral: case K.NoSubstitutionTemplateLiteral:
    case K.TrueKeyword: case K.FalseKeyword: case K.NullKeyword:
      return true;
    case K.Identifier:
      return n.text === 'undefined' || n.text === 'NaN' || n.text === 'Infinity';
    case K.PrefixUnaryExpression:
      return (n.operator === K.MinusToken || n.operator === K.PlusToken) && isLiteralTree(n.operand);
    case K.ArrayLiteralExpression:
      return n.elements.every(el => el.kind === K.OmittedExpression || isLiteralTree(el));
    case K.ObjectLiteralExpression:
      return n.properties.every(p => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && isLiteralTree(p.initializer));
    default:
      return false;
  }
}

/** An expression whose leftmost name is `z` (a zod schema). */
function isZRooted(n) {
  let e = n;
  for (;;) {
    if (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    else return ts.isIdentifier(e) && e.text === 'z';
  }
}

function propName(n) {
  return n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : '';
}

/** `x`, `a.b`, `this.x`, `a?.b`, `null`: an operand that is only looked at for presence. */
function isPresenceOperand(e) {
  e = stripWrappers(e);
  if (ts.isIdentifier(e) || e.kind === K.ThisKeyword || e.kind === K.NullKeyword) return true;
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return isPresenceOperand(e.expression);
  return false;
}

const isNullish = e => {
  e = stripWrappers(e);
  return e.kind === K.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e);
};

/** True when `cond` only tests presence, `typeof`, `err.code` or `instanceof`. */
function isGuard(cond) {
  const e = stripWrappers(cond);
  if (isPresenceOperand(e) || ts.isTypeOfExpression(e)) return true;
  if (ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken) return isGuard(e.operand);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === K.InstanceOfKeyword) return true;
    if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) return isGuard(e.left) && isGuard(e.right);
    if (op === K.EqualsEqualsToken || op === K.ExclamationEqualsToken || op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken) {
      const sides = [stripWrappers(e.left), stripWrappers(e.right)];
      if (sides.some(isNullish) || sides.some(ts.isTypeOfExpression)) return true;
      if (sides.some(s => ts.isPropertyAccessExpression(s) && s.name.text === 'code')) return true;
    }
  }
  return false;
}

/**
 * Classify one source text. Returns the class of each code line (null for a line that is not code),
 * the point counts, and the functions found: [{ name, qname, line, points, effects }].
 */
export function analyzeSource(text, fileName, opt = DEFAULT_OPT) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineCount = sf.getLineStarts().length;
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line;
  const code = new Uint8Array(lineCount);
  const best = new Uint8Array(lineCount);
  const mark = (line, cls) => {
    if (RANK[cls] > best[line]) best[line] = RANK[cls];
  };
  const markSpan = (n, cls) => {
    const a = lineOf(n.getStart(sf));
    const b = lineOf(Math.max(n.getEnd() - 1, n.getStart(sf)));
    for (let l = a; l <= b; l++) mark(l, cls);
  };
  const markAt = (pos, cls) => mark(lineOf(pos), cls);

  // Code lines: every line that holds a token other than a closer or a separator.
  const closers = new Set([K.CloseBraceToken, K.CloseParenToken, K.CloseBracketToken, K.SemicolonToken, K.CommaToken]);
  (function tokens(n) {
    if (n.kind >= K.FirstJSDocNode && n.kind <= K.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0) {
      if (n.kind === K.EndOfFileToken || closers.has(n.kind)) return;
      const a = lineOf(n.getStart(sf));
      const b = lineOf(Math.max(n.getEnd() - 1, n.getStart(sf)));
      for (let l = a; l <= b; l++) code[l] = 1;
      return;
    }
    for (const c of kids) tokens(c);
  })(sf);
  if (opt.commentLines) {
    const sc = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
    for (let t = sc.scan(); t !== K.EndOfFileToken; t = sc.scan()) {
      if (t !== K.MultiLineCommentTrivia && t !== K.SingleLineCommentTrivia) continue;
      const a = lineOf(sc.getTokenStart());
      const b = lineOf(Math.max(sc.getTokenEnd() - 1, sc.getTokenStart()));
      for (let l = a; l <= b; l++) code[l] = 1;
    }
  }

  // Names imported from a host module (`import { join } from 'path'`) are host API roots in this file.
  const hostNames = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !opt.hostModules.test(st.moduleSpecifier.text)) continue;
    const ic = st.importClause;
    if (!ic || ic.isTypeOnly) continue;
    if (ic.name) hostNames.add(ic.name.text);
    const nb = ic.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) hostNames.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) hostNames.add(el.name.text);
  }

  const counts = { decisions: 0, regexLiterals: 0, transforms: 0, guards: 0 };
  const functions = [];
  const fnStack = [];
  const classStack = [];
  const point = kind => {
    counts[kind]++;
    for (const f of fnStack) f.points++;
  };
  const effect = kind => {
    for (const f of fnStack) f.effects.add(kind);
  };

  function functionName(n) {
    switch (n.kind) {
      case K.FunctionDeclaration: case K.MethodDeclaration: case K.Constructor: case K.GetAccessor: case K.SetAccessor:
        return n.body ? (n.name ? n.name.getText(sf) : n.kind === K.Constructor ? 'constructor' : 'default') : null;
      case K.ArrowFunction: case K.FunctionExpression: {
        const p = n.parent;
        const bound = (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer === n && p.name;
        return bound ? p.name.getText(sf) : null;
      }
      default:
        return null;
    }
  }

  function boundaryCall(n) {
    const names = chainNames(n.expression);
    if (names.length === 0) return false;
    if (opt.hostRoots.has(names[0]) || hostNames.has(names[0])) return true;
    if (ts.isNewExpression(n)) return opt.ctors.test(names[names.length - 1]);
    return names.slice(0, -1).some(x => opt.receiver.test(x));
  }

  function visit(n) {
    const fname = functionName(n);
    if (fname !== null) {
      const cls = classStack[classStack.length - 1];
      const member = cls && (n.parent === cls || (ts.isPropertyDeclaration(n.parent) && n.parent.parent === cls));
      const f = { name: fname, qname: member ? `${cls.name?.text ?? 'default'}.${fname}` : fname, line: lineOf(n.getStart(sf)) + 1, points: 0, effects: new Set() };
      functions.push(f);
      fnStack.push(f);
    }
    const isClass = n.kind === K.ClassDeclaration || n.kind === K.ClassExpression;
    if (isClass) classStack.push(n);

    switch (n.kind) {
      // type
      case K.InterfaceDeclaration: case K.TypeAliasDeclaration: case K.EnumDeclaration: case K.ModuleDeclaration:
      case K.ImportDeclaration: case K.ImportEqualsDeclaration:
      case K.MethodSignature: case K.CallSignature: case K.ConstructSignature: case K.IndexSignature: case K.PropertySignature:
        markSpan(n, 'type');
        break;
      case K.ExportDeclaration:
        if (n.moduleSpecifier) markSpan(n, 'type');
        break;
      case K.FunctionDeclaration: case K.MethodDeclaration: case K.Constructor:
        if (!n.body) markSpan(n, 'type');
        break;
      case K.PropertyDeclaration:
        if (!n.initializer) markSpan(n, 'type');
        else if (propName(n) === 'inputSchema' || propName(n) === 'description') markSpan(n, 'data');
        break;
      // data
      case K.VariableStatement:
        if (n.modifiers?.some(m => m.kind === K.DeclareKeyword)) markSpan(n, 'type');
        else if (n.parent.kind === K.SourceFile && (n.declarationList.flags & ts.NodeFlags.Const)
          && n.declarationList.declarations.every(d => d.initializer && (isLiteralTree(d.initializer) || isZRooted(d.initializer)))) markSpan(n, 'data');
        break;
      case K.PropertyAssignment:
        if (propName(n) === 'inputSchema' || propName(n) === 'description') markSpan(n, 'data');
        break;
      // text
      case K.TemplateExpression: case K.NoSubstitutionTemplateLiteral:
        markSpan(n, 'text');
        break;
      // logic and points
      case K.IfStatement:
        markAt(n.getStart(sf), 'logic');
        if (isGuard(n.expression)) counts.guards++; else point('decisions');
        break;
      case K.SwitchStatement: case K.DefaultClause:
        markAt(n.getStart(sf), 'logic');
        break;
      case K.CaseClause:
        markAt(n.getStart(sf), 'logic');
        point('decisions');
        break;
      case K.ForStatement: case K.ForInStatement: case K.ForOfStatement: case K.WhileStatement: case K.DoStatement:
        markAt(n.getStart(sf), 'logic');
        point('decisions');
        break;
      case K.ConditionalExpression:
        markAt(n.condition.getStart(sf), 'logic');
        point('decisions');
        break;
      case K.AwaitExpression:
        effect('await');
        break;
      case K.BinaryExpression: {
        const op = n.operatorToken.kind;
        if (op >= K.FirstAssignment && op <= K.LastAssignment && (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left))) effect('assign');
        if (op === K.EqualsToken || op === K.CommaToken || op === K.PlusEqualsToken) break;
        markAt(n.operatorToken.getStart(sf), 'logic');
        if (op === K.AmpersandAmpersandToken || op === K.BarBarToken || op === K.QuestionQuestionToken) point('decisions');
        break;
      }
      case K.RegularExpressionLiteral:
        markAt(n.getStart(sf), 'logic');
        point('regexLiterals');
        break;
      case K.CallExpression: {
        const callee = n.expression;
        if (ts.isPropertyAccessExpression(callee) && opt.transforms.has(callee.name.text)) {
          markAt(callee.name.getStart(sf), 'logic');
          point('transforms');
        }
        if (boundaryCall(n)) {
          markSpan(n, 'boundary');
          effect('boundary');
        }
        break;
      }
      case K.NewExpression:
        if (boundaryCall(n)) {
          markSpan(n, 'boundary');
          effect('boundary');
        }
        break;
      default:
        break;
    }

    ts.forEachChild(n, visit);
    if (isClass) classStack.pop();
    if (fname !== null) fnStack.pop();
  }
  visit(sf);

  const lines = new Array(lineCount).fill(null);
  for (let l = 0; l < lineCount; l++) {
    if (code[l]) lines[l] = best[l] ? BY_RANK[best[l]] : 'glue';
  }
  return { lines, counts, functions, lineCount };
}

// ---------------------------------------------------------------------------
// Measuring a revision
// ---------------------------------------------------------------------------

/** An effectful function calls a host API, awaits, or assigns to a property. */
const isEffectful = f => f.effects.size > 0;

export function measure({ repo = DEFAULT_REPO, rev = 'HEAD', opt = DEFAULT_OPT } = {}) {
  const files = listSources(repo, rev);
  const total = {
    codeLines: 0, type: 0, data: 0, text: 0, boundary: 0, glue: 0, logic: 0,
    decisions: 0, regexLiterals: 0, transforms: 0, points: 0, guards: 0,
    functions: 0, functionsWithPoint: 0, pure: 0, effectful: 0,
  };
  const boundaryFiles = { files: 0, codeLines: 0, points: 0 };
  const perFile = new Map();
  for (const f of files) {
    const text = readAt(repo, rev, f);
    if (text === null) continue;
    const a = analyzeSource(text, f, opt);
    const codeLines = a.lines.filter(Boolean).length;
    if (BOUNDARY_FILE.test(f)) {
      boundaryFiles.files++;
      boundaryFiles.codeLines += codeLines;
      boundaryFiles.points += a.counts.decisions + a.counts.regexLiterals + a.counts.transforms;
      continue;
    }
    perFile.set(f, { ...a, text });
    total.codeLines += codeLines;
    for (const c of a.lines) if (c) total[c]++;
    for (const k of ['decisions', 'regexLiterals', 'transforms', 'guards']) total[k] += a.counts[k];
    for (const fn of a.functions) {
      total.functions++;
      if (fn.points === 0) continue;
      total.functionsWithPoint++;
      if (isEffectful(fn)) total.effectful++; else total.pure++;
    }
  }
  total.points = total.decisions + total.regexLiterals + total.transforms;
  return { rev, files: files.length - boundaryFiles.files, boundaryFiles, total, perFile };
}

/** Share of the base logic points that have left the TypeScript: (base - now) / base. */
export function shareOf(basePoints, points) {
  return basePoints > 0 ? (basePoints - points) / basePoints : 0;
}

// ---------------------------------------------------------------------------
// Sample for the manual audit
// ---------------------------------------------------------------------------

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

/** `n` distinct code lines, uniformly at random for `seed`, in file order: [{ file, line, cls, text }]. */
export function sampleLines(result, n, seed) {
  const all = [];
  for (const [file, a] of result.perFile) {
    a.lines.forEach((cls, i) => {
      if (cls) all.push([file, i]);
    });
  }
  const rnd = mulberry32(seed);
  const picked = new Set();
  const want = Math.min(n, all.length);
  while (picked.size < want) picked.add(Math.floor(rnd() * all.length));
  return [...picked].sort((x, y) => x - y).map(i => {
    const [file, l] = all[i];
    const a = result.perFile.get(file);
    return { file, line: l + 1, cls: a.lines[l], text: a.text.split('\n')[l].trim() };
  });
}

// ---------------------------------------------------------------------------
// MOVED.tsv
// ---------------------------------------------------------------------------

const MOVED_HEADER = ['spec_fn', 'source_file', 'source_symbol', 'base_rev', 'oracle_file', 'test_file'];

/** Parse specs/MOVED.tsv: the header line, then one row per line. Throws on a wrong header or column count. */
export function parseMoved(text) {
  const lines = text.split('\n').filter(l => l.trim() !== '' && !l.startsWith('#'));
  if (lines.length === 0 || lines[0] !== MOVED_HEADER.join('\t')) {
    throw new Error(`MOVED.tsv must start with the header: ${MOVED_HEADER.join('<TAB>')}`);
  }
  return lines.slice(1).map((l, i) => {
    const cols = l.split('\t');
    if (cols.length !== MOVED_HEADER.length) throw new Error(`MOVED.tsv row ${i + 1} has ${cols.length} columns, expected ${MOVED_HEADER.length}`);
    return Object.fromEntries(MOVED_HEADER.map((h, j) => [h, cols[j].trim()]));
  });
}

/** Spec functions: the `pub fn` names, and those that are exported (listed in specs/exports.txt, or called by an exported function). */
function specFunctions(repo, rev) {
  const specTexts = listAt(repo, rev, 'specs').filter(f => /^specs\/[^/]+\.t27$/.test(f)).map(f => readAt(repo, rev, f) ?? '');
  const listed = new Set();
  for (const line of (readAt(repo, rev, 'specs/exports.txt') ?? '').split('\n')) {
    for (const tok of line.replace(/#.*/, '').split(/\s+/)) if (tok) listed.add(tok);
  }
  const bodies = new Map();
  const pub = new Set();
  for (const text of specTexts) {
    const heads = [...text.matchAll(/(^|\n)[ \t]*(pub[ \t]+)?fn[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/g)];
    heads.forEach((m, i) => {
      if (m[2]) pub.add(m[3]);
      const body = text.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : text.length);
      bodies.set(m[3], body.slice(body.indexOf('\n', 1) + 1));
    });
  }
  const exported = new Set([...listed].filter(n => bodies.has(n)));
  const queue = [...exported];
  while (queue.length) {
    const body = bodies.get(queue.pop());
    for (const callee of bodies.keys()) {
      if (!exported.has(callee) && new RegExp(`\\b${callee}\\s*\\(`).test(body)) {
        exported.add(callee);
        queue.push(callee);
      }
    }
  }
  return { pub, exported };
}

/** Logic points of the function or method `symbol` (`name` or `Class.name`) in `text`, nested functions included; null when it is not there. */
export function symbolPoints(text, file, symbol, opt = DEFAULT_OPT) {
  const hits = analyzeSource(text, file, opt).functions.filter(f => f.qname === symbol);
  return hits.length === 0 ? null : hits.reduce((s, f) => s + f.points, 0);
}

/**
 * Check the MOVED rows. Returns [{ row, ok, failures, points }]; `points` is what a confirmed row moved:
 * the logic points its source symbol held at base_rev.
 */
export function checkMoved({ repo = DEFAULT_REPO, rev = 'HEAD', movedPath = 'specs/MOVED.tsv', opt = DEFAULT_OPT } = {}) {
  const text = readAt(repo, rev, movedPath);
  if (text === null) throw new Error(`${movedPath} is missing at ${rev}`);
  const rows = parseMoved(text);
  const { pub, exported } = specFunctions(repo, rev);
  return rows.map(row => {
    const failures = [];
    if (!pub.has(row.spec_fn)) failures.push(`1: no \`pub fn ${row.spec_fn}\` in specs/*.t27`);
    else if (!exported.has(row.spec_fn)) failures.push(`1: ${row.spec_fn} is not in specs/exports.txt and no exported function calls it`);

    const now = readAt(repo, rev, row.source_file);
    const left = now === null ? null : symbolPoints(now, row.source_file, row.source_symbol, opt);
    if (left !== null && left > 0) failures.push(`2: ${row.source_symbol} still holds ${left} logic points in ${row.source_file}`);

    const oracle = readAt(repo, rev, row.oracle_file);
    if (oracle === null) failures.push(`3: oracle ${row.oracle_file} does not exist`);
    else {
      const head = oracle.split('\n').slice(0, 30).join('\n');
      if (!head.includes(row.source_file)) failures.push(`3: the header of ${row.oracle_file} does not name ${row.source_file}`);
      if (row.base_rev.length < 7 || !head.includes(row.base_rev.slice(0, 7))) failures.push(`3: the header of ${row.oracle_file} does not name commit ${row.base_rev}`);
    }

    const testText = readAt(repo, rev, row.test_file);
    if (testText === null) failures.push(`4: test ${row.test_file} does not exist`);
    else {
      const dir = path.posix.dirname(row.test_file);
      const target = path.posix.normalize(row.oracle_file);
      const specs = [...testText.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map(m => m[1]);
      const imports = specs.some(s => (s.startsWith('.') ? path.posix.normalize(path.posix.join(dir, s)) : s) === target);
      if (!imports) failures.push(`4: ${row.test_file} does not import ${row.oracle_file}`);
    }

    let points = 0;
    if (failures.length === 0) {
      const base = readAt(repo, row.base_rev, row.source_file);
      points = base === null ? 0 : (symbolPoints(base, row.source_file, row.source_symbol, opt) ?? 0);
    }
    return { row, ok: failures.length === 0, failures, points };
  });
}

/** Points moved by the confirmed rows, once per distinct `source_file` and `source_symbol`. */
export function movedPoints(results) {
  const bySymbol = new Map();
  for (const r of results) {
    if (!r.ok) continue;
    const key = `${r.row.source_file}\0${r.row.source_symbol}`;
    if (!bySymbol.has(key)) bySymbol.set(key, r.points);
  }
  return [...bySymbol.values()].reduce((sum, p) => sum + p, 0);
}

/** Spec counts at `rev`: files `specs/*.t27`, their `fn` declarations (pub or not), and their lines (as `wc -l`). */
function specCounts(repo, rev) {
  const files = listAt(repo, rev, 'specs').filter(f => /^specs\/[^/]+\.t27$/.test(f));
  let specFns = 0;
  let t27Lines = 0;
  for (const f of files) {
    const text = readAt(repo, rev, f) ?? '';
    specFns += [...text.matchAll(/(^|\n)[ \t]*(pub[ \t]+)?fn[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*\(/g)].length;
    t27Lines += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }
  return { specs: files.length, specFns, t27Lines };
}

/**
 * The numbers of the README paragraph, from one place:
 *   base       logic points of the TypeScript at `baseRev` (default BASE_REV)
 *   now        logic points of the TypeScript at `rev` (boundary files apart, not counted)
 *   moved      points of the confirmed MOVED.tsv rows, once per symbol
 *   added      now - (base - moved): points that are in the TypeScript now and were not in the base
 *   specs, specFns, t27Lines   the t27 specs at `rev`
 *   codeLines  code lines of the TypeScript at `rev`; classes  its lines per class
 *   boundaryFiles  { files, lines, points }: the boundary files (src/rules/wasm.ts, marshal.ts, generated/), which
 *              are measured apart: their code lines and logic points are not in `now`, `codeLines` or `classes`
 *   allIn      the share with the points of the boundary files counted as TypeScript:
 *              (base - (now + boundaryFiles.points)) / base. `shareOf(base, now)` leaves them out.
 * Throws when `baseRev` is not in the repository or specs/MOVED.tsv is missing at `rev`.
 */
export function shareNumbers({ repo = DEFAULT_REPO, rev = 'HEAD', baseRev = BASE_REV, opt = DEFAULT_OPT } = {}) {
  if (resolveRev(repo, baseRev) === null) throw new Error(`the base revision ${baseRev} is not in ${repo}`);
  const now = measure({ repo, rev, opt });
  const base = measure({ repo, rev: baseRev, opt });
  const moved = movedPoints(checkMoved({ repo, rev, opt }));
  const t = now.total;
  const boundaryFiles = { files: now.boundaryFiles.files, lines: now.boundaryFiles.codeLines, points: now.boundaryFiles.points };
  return {
    base: base.total.points,
    now: t.points,
    moved,
    added: t.points - (base.total.points - moved),
    ...specCounts(repo, rev),
    codeLines: t.codeLines,
    classes: { type: t.type, data: t.data, text: t.text, boundary: t.boundary, glue: t.glue, logic: t.logic },
    boundaryFiles,
    allIn: shareOf(base.total.points, t.points + boundaryFiles.points),
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const fmt = n => n.toLocaleString('en-US');

const ROWS = [
  ['Code lines', 'codeLines'], ['  type', 'type'], ['  data', 'data'], ['  text', 'text'], ['  boundary', 'boundary'], ['  glue', 'glue'], ['  logic', 'logic'],
  ['Decisions', 'decisions'], ['Regex literals', 'regexLiterals'], ['Transforms', 'transforms'], ['Logic points (denominator)', 'points'],
  ['Guards (excluded)', 'guards'], ['Functions: total', 'functions'], ['Functions with a point', 'functionsWithPoint'],
  ['  pure', 'pure'], ['  effectful', 'effectful'],
];

export function formatTable(result, { base = null } = {}) {
  const t = result.total;
  const out = [];
  out.push(`Measured at ${result.rev}: ${result.files} files (tests excluded); boundary files apart: ${result.boundaryFiles.files} (${result.boundaryFiles.codeLines} code lines, ${result.boundaryFiles.points} logic points).`);
  out.push('');
  const w = Math.max(...ROWS.map(r => r[0].length));
  out.push(`${'Measure'.padEnd(w)}  ${'Value'.padStart(8)}`);
  for (const [label, key] of ROWS) {
    out.push(`${label.padEnd(w)}  ${fmt(t[key]).padStart(8)}`);
  }
  out.push('');
  if (base) out.push(`Share moved to t27: ${(shareOf(base.points, t.points) * 100).toFixed(2)}% = (${fmt(base.points)} - ${fmt(t.points)}) / ${fmt(base.points)}; base points measured at ${base.rev}.`);
  else out.push('Share moved to t27: n/a (the base revision is not in this repository).');
  return out.join('\n');
}

function parseArgs(argv) {
  const o = { rev: 'HEAD', repo: DEFAULT_REPO, baseRev: BASE_REV, json: false, sample: 0, seed: 27, checkMoved: false, moved: 'specs/MOVED.tsv', commentLines: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--rev') o.rev = next();
    else if (a === '--repo') o.repo = path.resolve(next());
    else if (a === '--base-rev') o.baseRev = next();
    else if (a === '--json') o.json = true;
    else if (a === '--sample') o.sample = Number(next());
    else if (a === '--seed') o.seed = Number(next());
    else if (a === '--comment-lines') o.commentLines = true;
    else if (a === '--check-moved') o.checkMoved = true;
    else if (a === '--moved') o.moved = next();
    else throw new Error(`unknown option ${a}`);
  }
  if (!Number.isInteger(o.sample) || o.sample < 0) throw new Error('--sample needs a whole number');
  if (!Number.isInteger(o.seed)) throw new Error('--seed needs a whole number');
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const opt = { ...DEFAULT_OPT, commentLines: o.commentLines };
  if (o.checkMoved) {
    const results = checkMoved({ repo: o.repo, rev: o.rev, movedPath: o.moved, opt });
    const bad = results.filter(r => !r.ok);
    const moved = movedPoints(results);
    if (o.json) console.log(JSON.stringify({ rows: results.length, confirmed: results.length - bad.length, points: moved, failures: bad }, null, 2));
    else {
      for (const r of bad) console.log(`FAIL ${r.row.spec_fn}\n  ${r.failures.join('\n  ')}`);
      console.log(`MOVED.tsv: ${results.length} rows, ${results.length - bad.length} confirmed, ${moved} logic points moved`);
    }
    process.exit(bad.length ? 1 : 0);
  }
  const result = measure({ repo: o.repo, rev: o.rev, opt });
  const label = resolveRev(o.repo, o.rev) ?? o.rev;
  if (o.sample > 0) {
    for (const s of sampleLines(result, o.sample, o.seed)) console.log(`${s.file}:${s.line}\t${s.cls}\t${s.text}`);
    return;
  }
  const baseLabel = resolveRev(o.repo, o.baseRev);
  const base = baseLabel ? { rev: baseLabel, points: baseLabel === label ? result.total.points : measure({ repo: o.repo, rev: o.baseRev, opt }).total.points } : null;
  if (o.json) {
    const { perFile, ...rest } = result;
    console.log(JSON.stringify({ ...rest, rev: label, base, share: base ? shareOf(base.points, result.total.points) : null }, null, 2));
    return;
  }
  console.log(formatTable({ ...result, rev: label }, { base }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`measure-t27-share: ${e.message}`);
    process.exit(2);
  }
}
