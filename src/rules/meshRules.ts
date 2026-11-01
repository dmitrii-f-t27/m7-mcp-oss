// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Facade of the peer-text rules (specs/mesh_rules.t27): how text from another workstation or peer is cleaned and
 * marked before it reaches the model (SEC-7).
 *
 * This file decides nothing about the text. It makes the text well-formed first (a lone surrogate becomes U+FFFD,
 * because UTF-8 cannot carry it), writes it into the wasm input buffer, calls the rule with the true length, and
 * reads the answer from the output buffer.
 *
 * The answer is never the raw text:
 * - a text over 3,145,728 bytes of UTF-8 is not cut: the answer is "[peer text refused: over the size limit]", the
 *   text of the rule `mr_refusal`;
 * - if the wasm is not available, a call traps, the answer is not a length that fits the buffer, or the bytes are not
 *   UTF-8, the answer is "[peer text refused: rules unavailable]".
 * `fenceHeader` is the one exception, because it only decides whether a header goes in front of an answer: when it
 * cannot tell, the header goes in front.
 *
 * Memory: the input buffer is 3 MiB and the output buffer 4.5 MiB inside the wasm memory, reserved when the module is
 * instantiated. See docs/T27_BOUNDARY.md.
 */

import { MR_ERR_LIMIT, MR_OUT_MAX, MR_TEXT_MAX } from './generated/constants.js';
import { checkU31, fromBool, putText, toWellFormedText } from './marshal.js';
import { callRules } from './wasm.js';
import type { RulesExports } from './wasm.js';

/** The answer when the rules cannot be used. */
export const REFUSED_UNAVAILABLE = '[peer text refused: rules unavailable]';

// ignoreBOM: the answer is the bytes of the rules as they are; a leading U+FEFF is not dropped.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The `n` bytes at `out` as text. Throws if the rules answered a length that cannot be one, or bytes that are not UTF-8. */
function answerText(mem: Uint8Array, out: number, n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > MR_OUT_MAX) throw new RangeError(`the rules answered ${String(n)}`);
  return decoder.decode(mem.subarray(out, out + n));
}

/** The refusal text for a text over the size limit, from the rules. */
function overLimit(x: RulesExports, mem: Uint8Array, out: number): string {
  return answerText(mem, out, x.mr_refusal(out));
}

/** Put `text` into the input buffer, call `call` with the true length, and read the output buffer. */
function run(text: string, call: (x: RulesExports, input: number, len: number, out: number) => number): string {
  return callRules((x, mem) => {
    const input = x.mr_addr_in();
    const out = x.mr_addr_out();
    const len = putText(mem, input, MR_TEXT_MAX, toWellFormedText(text));
    if (len < 0) return overLimit(x, mem, out);
    const n = call(x, input, len, out);
    return n === MR_ERR_LIMIT ? overLimit(x, mem, out) : answerText(mem, out, n);
  }, REFUSED_UNAVAILABLE);
}

/** Clean text: controls become spaces, fence marks are broken. With `keepLayout` line feeds and tabs stay. */
export function scrubText(text: string, keepLayout: boolean): string {
  return run(text, (x, input, len, out) => x.mr_scrub(input, len, Number(keepLayout), out));
}

/** Inline peer value: one line, marked; with `max` a longer value is cut and "..." shows the cut. */
export function inlineMarked(text: string, max: number | undefined): string {
  return run(text, (x, input, len, out) => x.mr_inline(input, len, max === undefined ? -1 : checkU31(max), out));
}

/** Instance id: the first 12 UTF-16 units, marked, then "...". */
export function idMarked(text: string): string {
  return run(text, (x, input, len, out) => x.mr_id(input, len, out));
}

/** Peer text with newlines, between two fence lines of its own. */
export function blockMarked(text: string): string {
  return run(text, (x, input, len, out) => x.mr_block(input, len, out));
}

/** `text` with `header` and a line feed in front when it holds the fence mark "<<<" or when the rules cannot tell. */
export function fenceHeader(text: string, header: string): string {
  const fenced = callRules((x, mem) => {
    const input = x.mr_addr_in();
    const len = putText(mem, input, MR_TEXT_MAX, toWellFormedText(text));
    return len < 0 || fromBool(x.mr_has_fence(input, len));
  }, true);
  return fenced ? `${header}\n${text}` : text;
}
