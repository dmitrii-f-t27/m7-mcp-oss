// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Facade of the network rules (specs/net_rules.t27): which Host and which Origin the visualizer accepts (SEC-6).
 *
 * This file decides nothing. It writes the header text into the wasm buffer, calls the rule with the true
 * length and the port, and reads the answer. Anything that goes wrong refuses: the wasm is not available, a call
 * traps, the text is over 256 bytes or has a lone surrogate, the port is not a whole number from 0 to 65535, or
 * the wasm answers a number that is not 0 or 1. That includes a request with no Origin header, which is allowed
 * only when the rules say so.
 */

import { NR_TEXT_MAX } from './generated/constants.js';
import { checkI32, fromBool, putTextOrThrow } from './marshal.js';
import { callRules } from './wasm.js';

/** The Host header of an HTTP request. A missing header is refused. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return callRules((x, mem) => {
    const a = x.nr_addr_text();
    return fromBool(x.nr_host_allowed(a, putTextOrThrow(mem, a, NR_TEXT_MAX, host as string), checkI32(port)));
  }, false);
}

/** The Origin header of a WebSocket upgrade. No Origin header at all (undefined) is allowed. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  return callRules((x, mem) => {
    const a = x.nr_addr_text();
    const length = putTextOrThrow(mem, a, NR_TEXT_MAX, origin ?? '');
    return fromBool(x.nr_origin_allowed(Number(origin !== undefined), a, length, checkI32(port)));
  }, false);
}
