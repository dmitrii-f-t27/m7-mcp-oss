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
 * - A failed load stays failed. After a trap, a `WebAssembly.RuntimeError`, the instance is dropped (module state
 *   may be half written) and the next call makes a fresh one; the call that trapped is not retried. Any other
 *   throw, such as a refusal of the facade before the call (a text over its limit), returns the refusing value
 *   and keeps the instance: the wasm was not entered, so a refused input must not cost a new instance.
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
  // path_rules. A text argument is the address of a buffer in this memory (one of the pr_addr_* below) and the true
  // length of the text in it. A bool is 0 or 1. See specs/path_rules.t27 for the answers.
  pr_addr_a(): number;
  pr_addr_b(): number;
  pr_addr_seg(): number;
  pr_addr_joined(): number;
  pr_has_nul(buf: number, len: number): number;
  pr_seg_start(buf: number, len: number, pos: number): number;
  pr_seg_end(buf: number, len: number, start: number): number;
  pr_trim_end(buf: number, len: number): number;
  pr_push_verdict(joined: number, len: number): number;
  pr_pull_verdict(joined: number, len: number): number;
  pr_is_inside(root: number, rootLen: number, target: number, targetLen: number, win: number): number;
  pr_relative_start(root: number, rootLen: number, target: number, targetLen: number, win: number): number;
  pr_link_leaves(realNull: number, inside: number): number;
  pr_plain_entry_name(name: number, len: number): number;
  pr_env_source(hasCursor: number, hasTranscripts: number, hasM7: number, rootsComplete: number, cwdAllowsScan: number): number;
  pr_needs_switch(hasCurrent: number, cur: number, curLen: number, nxt: number, nxtLen: number): number;
  pr_unsafe_fallback(isHome: number, isValid: number): number;
  // net_rules, policy_rules: same convention (specs/net_rules.t27, specs/policy_rules.t27).
  nr_addr_text(): number;
  nr_host_allowed(text: number, len: number, port: number): number;
  nr_origin_allowed(hasOrigin: number, text: number, len: number, port: number): number;
  po_addr_head(): number;
  po_addr_list(): number;
  po_addr_text(): number;
  po_has_marker(head: number, len: number): number;
  po_managed_state(hasHead: number, head: number, len: number): number;
  po_write_action(state: number): number;
  po_sync_action(state: number): number;
  po_listing_empty(names: number, len: number, count: number): number;
  po_needs_init_note(isEmpty: number, hasMemoryBank: number, hasCursorRules: number): number;
  po_model_takes_temperature(model: number, len: number): number;
  po_remote_classification(value: number, len: number): number;
  // mesh_rules: text goes in at mr_addr_in and the answer comes out at mr_addr_out (specs/mesh_rules.t27).
  mr_addr_in(): number;
  mr_addr_out(): number;
  mr_is_control(code: number, keep: number): number;
  mr_scrub(input: number, len: number, keep: number, out: number): number;
  mr_inline(input: number, len: number, max: number, out: number): number;
  mr_id(input: number, len: number, out: number): number;
  mr_block(input: number, len: number, out: number): number;
  mr_has_fence(text: number, len: number): number;
  mr_refusal(out: number): number;
}

const REQUIRED_FUNCTIONS = [
  'by_fold_ascii', 'by_is_sep', 'by_is_cont',
  'pr_addr_a', 'pr_addr_b', 'pr_addr_seg', 'pr_addr_joined',
  'pr_has_nul', 'pr_seg_start', 'pr_seg_end', 'pr_trim_end', 'pr_push_verdict', 'pr_pull_verdict',
  'pr_is_inside', 'pr_relative_start', 'pr_link_leaves', 'pr_plain_entry_name',
  'pr_env_source', 'pr_needs_switch', 'pr_unsafe_fallback',
  'nr_addr_text', 'nr_host_allowed', 'nr_origin_allowed',
  'po_addr_head', 'po_addr_list', 'po_addr_text', 'po_has_marker', 'po_managed_state', 'po_write_action', 'po_sync_action',
  'po_listing_empty', 'po_needs_init_note', 'po_model_takes_temperature', 'po_remote_classification',
  'mr_addr_in', 'mr_addr_out', 'mr_is_control', 'mr_scrub', 'mr_inline', 'mr_id', 'mr_block', 'mr_has_fence', 'mr_refusal',
] as const;

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

/** The byte at `ptr` in the memory of `x`. */
function byteAt(x: RulesExports, ptr: number): number {
  return new Uint8Array(x.memory.buffer)[ptr];
}

/** Write `bytes` at `ptr` in the memory of `x` and return their count. */
function put(x: RulesExports, ptr: number, bytes: string): number {
  new Uint8Array(x.memory.buffer).set(Buffer.from(bytes, 'latin1'), ptr);
  return bytes.length;
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
  ['pr_push_verdict(".env")', x => x.pr_push_verdict(x.pr_addr_joined(), put(x, x.pr_addr_joined(), '.env\0')), 1],
  ['pr_push_verdict("src", "main.ts")', x => x.pr_push_verdict(x.pr_addr_joined(), put(x, x.pr_addr_joined(), 'src\0main.ts\0')), 0],
  ['pr_push_verdict(".git")', x => x.pr_push_verdict(x.pr_addr_joined(), put(x, x.pr_addr_joined(), '.git\0')), 0],
  ['pr_pull_verdict(".git")', x => x.pr_pull_verdict(x.pr_addr_joined(), put(x, x.pr_addr_joined(), '.git\0')), 2],
  ['pr_pull_verdict("a.key")', x => x.pr_pull_verdict(x.pr_addr_joined(), put(x, x.pr_addr_joined(), 'a.key\0')), 1],
  ['pr_has_nul("a", NUL, "b")', x => x.pr_has_nul(x.pr_addr_a(), put(x, x.pr_addr_a(), 'a\0b')), 1],
  ['pr_has_nul("ab")', x => x.pr_has_nul(x.pr_addr_a(), put(x, x.pr_addr_a(), 'ab')), 0],
  ['pr_seg_start("//a/b", 0)', x => x.pr_seg_start(x.pr_addr_a(), put(x, x.pr_addr_a(), '//a/b'), 0), 2],
  ['pr_seg_end("//a/b", 2)', x => x.pr_seg_end(x.pr_addr_a(), put(x, x.pr_addr_a(), '//a/b'), 2), 3],
  ['pr_trim_end("a. .")', x => x.pr_trim_end(x.pr_addr_seg(), put(x, x.pr_addr_seg(), 'a. .')), 1],
  ['pr_is_inside("/a", "/a/b")', x => x.pr_is_inside(x.pr_addr_a(), put(x, x.pr_addr_a(), '/a'), x.pr_addr_b(), put(x, x.pr_addr_b(), '/a/b'), 0), 1],
  ['pr_is_inside("/a", "/ab")', x => x.pr_is_inside(x.pr_addr_a(), put(x, x.pr_addr_a(), '/a'), x.pr_addr_b(), put(x, x.pr_addr_b(), '/ab'), 0), 0],
  ['pr_relative_start("/a", "/a/b")', x => x.pr_relative_start(x.pr_addr_a(), put(x, x.pr_addr_a(), '/a'), x.pr_addr_b(), put(x, x.pr_addr_b(), '/a/b'), 0), 3],
  ['pr_plain_entry_name("a")', x => x.pr_plain_entry_name(x.pr_addr_a(), put(x, x.pr_addr_a(), 'a')), 1],
  ['pr_plain_entry_name("..")', x => x.pr_plain_entry_name(x.pr_addr_a(), put(x, x.pr_addr_a(), '..')), 0],
  ['pr_needs_switch(same)', x => x.pr_needs_switch(1, x.pr_addr_a(), put(x, x.pr_addr_a(), '/a'), x.pr_addr_b(), put(x, x.pr_addr_b(), '/a')), 0],
  ['pr_needs_switch(different)', x => x.pr_needs_switch(1, x.pr_addr_a(), put(x, x.pr_addr_a(), '/a'), x.pr_addr_b(), put(x, x.pr_addr_b(), '/b')), 1],
  ['pr_link_leaves(0, 1)', x => x.pr_link_leaves(0, 1), 0],
  ['pr_link_leaves(1, 1)', x => x.pr_link_leaves(1, 1), 1],
  ['pr_unsafe_fallback(1, 0)', x => x.pr_unsafe_fallback(1, 0), 1],
  ['pr_unsafe_fallback(0, 0)', x => x.pr_unsafe_fallback(0, 0), 0],
  ['pr_env_source(1, 0, 0, 0, 0)', x => x.pr_env_source(1, 0, 0, 0, 0), 0],
  ['pr_env_source(0, 0, 0, 0, 0)', x => x.pr_env_source(0, 0, 0, 0, 0), 4],
  ['nr_host_allowed("localhost:8080")', x => x.nr_host_allowed(x.nr_addr_text(), put(x, x.nr_addr_text(), 'localhost:8080'), 8080), 1],
  ['nr_host_allowed("LocalHost:8080")', x => x.nr_host_allowed(x.nr_addr_text(), put(x, x.nr_addr_text(), 'LocalHost:8080'), 8080), 1],
  ['nr_host_allowed("localhost:8081")', x => x.nr_host_allowed(x.nr_addr_text(), put(x, x.nr_addr_text(), 'localhost:8081'), 8080), 0],
  ['nr_host_allowed("example.com:80")', x => x.nr_host_allowed(x.nr_addr_text(), put(x, x.nr_addr_text(), 'example.com:80'), 80), 0],
  ['nr_origin_allowed(none)', x => x.nr_origin_allowed(0, x.nr_addr_text(), 0, 8080), 1],
  ['nr_origin_allowed("http://127.0.0.1:1")', x => x.nr_origin_allowed(1, x.nr_addr_text(), put(x, x.nr_addr_text(), 'http://127.0.0.1:1'), 1), 1],
  ['nr_origin_allowed("https://localhost:1")', x => x.nr_origin_allowed(1, x.nr_addr_text(), put(x, x.nr_addr_text(), 'https://localhost:1'), 1), 0],
  ['po_has_marker(marker)', x => x.po_has_marker(x.po_addr_head(), put(x, x.po_addr_head(), '<!-- m7-managed -->')), 1],
  ['po_has_marker("x")', x => x.po_has_marker(x.po_addr_head(), put(x, x.po_addr_head(), 'x')), 0],
  ['po_managed_state(none)', x => x.po_managed_state(0, x.po_addr_head(), 0), 0],
  ['po_managed_state(marker)', x => x.po_managed_state(1, x.po_addr_head(), put(x, x.po_addr_head(), '<!-- m7-managed -->')), 1],
  ['po_managed_state("x")', x => x.po_managed_state(1, x.po_addr_head(), put(x, x.po_addr_head(), 'x')), 2],
  ['po_write_action(absent)', x => x.po_write_action(0), 0],
  ['po_write_action(foreign)', x => x.po_write_action(2), 2],
  ['po_sync_action(managed)', x => x.po_sync_action(1), 0],
  ['po_sync_action(absent)', x => x.po_sync_action(0), 1],
  ['po_listing_empty(.git)', x => x.po_listing_empty(x.po_addr_list(), put(x, x.po_addr_list(), '.git\0'), 1), 1],
  ['po_listing_empty(src)', x => x.po_listing_empty(x.po_addr_list(), put(x, x.po_addr_list(), '.git\0src\0'), 2), 0],
  ['po_needs_init_note(0, 0, 0)', x => x.po_needs_init_note(0, 0, 0), 1],
  ['po_needs_init_note(1, 0, 0)', x => x.po_needs_init_note(1, 0, 0), 0],
  ['po_model_takes_temperature(opus)', x => x.po_model_takes_temperature(x.po_addr_text(), put(x, x.po_addr_text(), 'claude-opus-4')), 0],
  ['po_model_takes_temperature(sonnet)', x => x.po_model_takes_temperature(x.po_addr_text(), put(x, x.po_addr_text(), 'claude-sonnet-4')), 1],
  ['po_remote_classification("true")', x => x.po_remote_classification(x.po_addr_text(), put(x, x.po_addr_text(), 'true')), 1],
  ['po_remote_classification("TRUE")', x => x.po_remote_classification(x.po_addr_text(), put(x, x.po_addr_text(), 'TRUE')), 0],
  ['mr_is_control(0x200b)', x => x.mr_is_control(0x200b, 0), 1],
  ['mr_is_control("a")', x => x.mr_is_control(97, 0), 0],
  ['mr_is_control(LF, keep)', x => x.mr_is_control(10, 1), 0],
  ['mr_is_control(LF)', x => x.mr_is_control(10, 0), 1],
  ['mr_scrub("a<<<b") length', x => x.mr_scrub(x.mr_addr_in(), put(x, x.mr_addr_in(), 'a<<<b'), 0, x.mr_addr_out()), 6],
  ['mr_scrub("a<<<b") space', x => { x.mr_scrub(x.mr_addr_in(), put(x, x.mr_addr_in(), 'a<<<b'), 0, x.mr_addr_out()); return byteAt(x, x.mr_addr_out() + 3); }, 32],
  ['mr_scrub(over the limit)', x => x.mr_scrub(x.mr_addr_in(), 3145729, 0, x.mr_addr_out()), -2],
  ['mr_inline("ab")', x => x.mr_inline(x.mr_addr_in(), put(x, x.mr_addr_in(), 'ab'), -1, x.mr_addr_out()), 8],
  ['mr_inline("abcd", 2)', x => x.mr_inline(x.mr_addr_in(), put(x, x.mr_addr_in(), 'abcd'), 2, x.mr_addr_out()), 11],
  ['mr_id("abcd")', x => x.mr_id(x.mr_addr_in(), put(x, x.mr_addr_in(), 'abcd'), x.mr_addr_out()), 13],
  ['mr_block("a")', x => x.mr_block(x.mr_addr_in(), put(x, x.mr_addr_in(), 'a'), x.mr_addr_out()), 9],
  ['mr_has_fence("a<<<")', x => x.mr_has_fence(x.mr_addr_in(), put(x, x.mr_addr_in(), 'a<<<')), 1],
  ['mr_has_fence("a<<")', x => x.mr_has_fence(x.mr_addr_in(), put(x, x.mr_addr_in(), 'a<<')), 0],
  ['mr_refusal length', x => x.mr_refusal(x.mr_addr_out()), 40],
  ['mr_refusal first byte', x => { x.mr_refusal(x.mr_addr_out()); return byteAt(x, x.mr_addr_out()); }, 91],
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
 * the refusing value of the rule. A trap (`WebAssembly.RuntimeError`) also drops the instance; a refusal does
 * not. The call is not retried.
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
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) instance = null;
    return onFail;
  }
}

/** Like `callRules`, but for a caller that must not carry on: it throws `RulesUnavailableError` instead. */
export function callRulesOrThrow<T>(call: (x: RulesExports, mem: Uint8Array) => T): T {
  const x = current();
  try {
    return call(x, new Uint8Array(x.memory.buffer));
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) instance = null;
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
