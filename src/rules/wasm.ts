// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Loader for wasm/m7_rules.wasm, the t27 rules compiled from specs/ (see docs/T27_BOUNDARY.md).
 *
 * Rules for this file:
 * - Fail closed. A missing, changed or broken wasm, a trap, or a wrong answer to a known-answer call is
 *   `RulesUnavailableError`, and a caller that gets it uses the refusing value of its rule.
 * - The path is fixed: wasm/ next to dist/. No environment variable, option or argument changes it, and
 *   `src/rules/` reads no environment variable.
 * - The file must have the SHA-256 in generated/constants.ts (written by specs/generate.sh), no imports,
 *   and give the right answer to a few known calls.
 * - Loading is synchronous and lazy, because `pushRefusal` and `selectProjectSource` are synchronous.
 *   `assertRulesLoaded()` at start-up (src/index.ts) makes a bad install stop the server before it serves.
 * - A failed load stays failed. After a trap the instance is dropped (module state may be half written)
 *   and the next call makes a fresh one; the call that trapped is not retried.
 * - `memory.buffer` is read again on every call: `memory.grow` detaches the old one.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WASM_SHA256 } from './generated/constants.js';

export class RulesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesUnavailableError';
  }
}

/** What wasm/m7_rules.wasm exports. Scalars are numbers; the facades range-check them (marshal.ts). */
export interface RulesExports {
  memory: WebAssembly.Memory;
  by_fold_ascii(b: number): number;
  by_is_sep(b: number, win: number): number;
  by_is_cont(b: number): number;
}

const REQUIRED_FUNCTIONS = ['by_fold_ascii', 'by_is_sep', 'by_is_cont'] as const;

let verifiedModule: WebAssembly.Module | null = null;
let instance: RulesExports | null = null;
let loadError: RulesUnavailableError | null = null;

function unavailable(what: string, cause?: unknown): RulesUnavailableError {
  const detail = cause instanceof Error ? `: ${cause.message}` : '';
  return new RulesUnavailableError(`${what}${detail}`);
}

/** wasm/m7_rules.wasm beside the real dist/ folder. The module is looked up through its symbolic links. */
function wasmFile(): string {
  const here = pathToFileURL(realpathSync(fileURLToPath(import.meta.url)));
  return fileURLToPath(new URL('../../wasm/m7_rules.wasm', here));
}

function loadModule(): WebAssembly.Module {
  const file = wasmFile();
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    throw unavailable(`cannot read ${file}`, e);
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== WASM_SHA256) throw new RulesUnavailableError(`${file} has SHA-256 ${sha}, expected ${WASM_SHA256}`);
  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch (e) {
    throw unavailable(`${file} is not a valid wasm module`, e);
  }
  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) throw new RulesUnavailableError(`${file} has imports: ${imports.map(i => `${i.module}.${i.name}`).join(', ')}`);
  return module;
}

const KNOWN_ANSWERS: Array<[string, (x: RulesExports) => number, number]> = [
  ['by_fold_ascii(64)', x => x.by_fold_ascii(64), 64],
  ['by_fold_ascii(65)', x => x.by_fold_ascii(65), 97],
  ['by_fold_ascii(90)', x => x.by_fold_ascii(90), 122],
  ['by_fold_ascii(91)', x => x.by_fold_ascii(91), 91],
  ['by_fold_ascii(97)', x => x.by_fold_ascii(97), 97],
  ['by_is_sep(47, 0)', x => x.by_is_sep(47, 0), 1],
  ['by_is_sep(92, 0)', x => x.by_is_sep(92, 0), 0],
  ['by_is_sep(92, 1)', x => x.by_is_sep(92, 1), 1],
  ['by_is_sep(46, 1)', x => x.by_is_sep(46, 1), 0],
  ['by_is_cont(127)', x => x.by_is_cont(127), 0],
  ['by_is_cont(128)', x => x.by_is_cont(128), 1],
  ['by_is_cont(191)', x => x.by_is_cont(191), 1],
  ['by_is_cont(192)', x => x.by_is_cont(192), 0],
];

function instantiate(module: WebAssembly.Module): RulesExports {
  const exports = new WebAssembly.Instance(module, {}).exports as unknown as Record<string, unknown>;
  if (typeof exports._initialize !== 'function') throw new RulesUnavailableError('the wasm has no _initialize export');
  (exports._initialize as () => void)();
  if (!(exports.memory instanceof WebAssembly.Memory)) throw new RulesUnavailableError('the wasm has no memory export');
  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof exports[name] !== 'function') throw new RulesUnavailableError(`the wasm does not export ${name}`);
  }
  const rules = exports as unknown as RulesExports;
  for (const [label, call, want] of KNOWN_ANSWERS) {
    const got = call(rules);
    if (got !== want) throw new RulesUnavailableError(`known answer failed: ${label} gave ${String(got)}, wanted ${want}`);
  }
  return rules;
}

/** The live instance. Loads on first use; a failed load is remembered and thrown again. */
function current(): RulesExports {
  if (instance !== null) return instance;
  if (loadError !== null) throw loadError;
  try {
    verifiedModule ??= loadModule();
    instance = instantiate(verifiedModule);
    return instance;
  } catch (e) {
    loadError = e instanceof RulesUnavailableError ? e : unavailable('loading the rules wasm failed', e);
    throw loadError;
  }
}

/** Load the rules now. Throws `RulesUnavailableError` if they cannot be used. Call it before serving. */
export function assertRulesLoaded(): void {
  current();
}

/**
 * Run `call` on the rules. Any throw (a trap, a refused argument, an unavailable wasm) returns `onFail`,
 * the refusing value of the rule, and drops the instance. The call is not retried.
 */
export function callRules<T>(call: (x: RulesExports, mem: Uint8Array) => T, onFail: T): T {
  let x: RulesExports;
  try {
    x = current();
  } catch {
    return onFail;
  }
  try {
    return call(x, new Uint8Array(x.memory.buffer));
  } catch {
    instance = null;
    return onFail;
  }
}

/** Like `callRules`, but for a caller that must not carry on: it throws `RulesUnavailableError` instead. */
export function callRulesOrThrow<T>(call: (x: RulesExports, mem: Uint8Array) => T): T {
  const x = current();
  try {
    return call(x, new Uint8Array(x.memory.buffer));
  } catch (e) {
    instance = null;
    throw unavailable('a rules call failed', e);
  }
}

/**
 * Tests only. A stub replaces the instance (it skips the known answers); `null` forgets the instance, the
 * verified module and a remembered load failure, so the next call loads from the file again.
 */
export function setRulesExportsForTests(x: RulesExports | null): void {
  instance = x;
  if (x === null) {
    verifiedModule = null;
    loadError = null;
  }
}
