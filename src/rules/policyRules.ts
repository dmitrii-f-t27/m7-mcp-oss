// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Facade of the write-policy rules (specs/policy_rules.t27): the managed marker and the write states (SEC-2),
 * the empty-directory and init-note rules, the Opus temperature rule (SEC-9) and the remote-classification
 * switch (SEC-3).
 *
 * This file decides nothing. It writes the text into the wasm buffer, calls the rule with the true length, and
 * reads the answer. Anything that goes wrong gives the refusing value of the rule: no marker, state "foreign",
 * write "skip", sync "skip", listing not empty, no init note, no temperature, no remote classification. That
 * means: the wasm is not available, a call traps, a text is over its limit (256 bytes for a model name or a
 * value, 65536 bytes for a listing) or has a lone surrogate, or the wasm answers a number the facade does not know.
 */

import type { ManagedState, ManagedSyncAction, ManagedWriteAction } from '../core/utils/safeWrite.js';
import {
  PO_HEAD_MAX, PO_LIST_MAX, PO_STATE_ABSENT, PO_STATE_FOREIGN, PO_STATE_MANAGED, PO_SYNC_SKIP, PO_SYNC_SYNC, PO_TEXT_MAX,
  PO_WRITE_CREATE, PO_WRITE_SKIP, PO_WRITE_UPDATE,
} from './generated/constants.js';
import { asBytes, checkI32, fromBool, putNulList, putPrefix, putTextOrThrow } from './marshal.js';
import { callRules } from './wasm.js';

const STATE_NAME: Record<number, ManagedState> = {
  [PO_STATE_ABSENT]: 'absent',
  [PO_STATE_MANAGED]: 'managed',
  [PO_STATE_FOREIGN]: 'foreign',
};
const STATE_CODE: Record<ManagedState, number> = {
  absent: PO_STATE_ABSENT,
  managed: PO_STATE_MANAGED,
  foreign: PO_STATE_FOREIGN,
};
const WRITE_NAME: Record<number, ManagedWriteAction> = {
  [PO_WRITE_CREATE]: 'create',
  [PO_WRITE_UPDATE]: 'update',
  [PO_WRITE_SKIP]: 'skip',
};
const SYNC_NAME: Record<number, ManagedSyncAction> = {
  [PO_SYNC_SYNC]: 'sync',
  [PO_SYNC_SKIP]: 'skip',
};
const NO_BYTES = new Uint8Array(0);

/** The name of an answer of the rules. Throws if the rules answered a number that has no name. */
function nameOf<T>(names: Record<number, T>, code: number): T {
  const name = names[code];
  if (name === undefined) throw new RangeError(`the rules answered ${code}`);
  return name;
}

const flag = (value: unknown): number => Number(Boolean(value));

/** The managed marker lies fully inside the first 4096 bytes of the content (the window is the rule). */
export function hasMarker(content: string | Uint8Array): boolean {
  return callRules((x, mem) => {
    const a = x.po_addr_head();
    return fromBool(x.po_has_marker(a, putPrefix(mem, a, PO_HEAD_MAX, asBytes(content))));
  }, false);
}

/** State of a file from the start of its content; null is a file that does not exist. */
export function managedState(head: Uint8Array | null): ManagedState {
  return callRules((x, mem) => {
    const a = x.po_addr_head();
    return nameOf(STATE_NAME, x.po_managed_state(Number(head !== null), a, putPrefix(mem, a, PO_HEAD_MAX, head ?? NO_BYTES)));
  }, 'foreign');
}

/** What M7 may do with a file in this state. */
export function writeAction(state: ManagedState): ManagedWriteAction {
  return callRules(x => nameOf(WRITE_NAME, x.po_write_action(checkI32(STATE_CODE[state]))), 'skip');
}

/** What M7 may do when it syncs a note into an existing reference file. */
export function syncAction(state: ManagedState): ManagedSyncAction {
  return callRules(x => nameOf(SYNC_NAME, x.po_sync_action(checkI32(STATE_CODE[state]))), 'skip');
}

/** The directory with these entry names is empty for M7. */
export function listingEmpty(names: readonly string[]): boolean {
  return callRules((x, mem) => {
    const a = x.po_addr_list();
    return fromBool(x.po_listing_empty(a, putNulList(mem, a, PO_LIST_MAX, names), names.length));
  }, false);
}

/** analyze_task should tell the user that M7 is not set up here. */
export function needsInitNote(state: { isEmpty: boolean; hasMemoryBank: boolean; hasCursorRules: boolean }): boolean {
  return callRules(x => fromBool(x.po_needs_init_note(flag(state.isEmpty), flag(state.hasMemoryBank), flag(state.hasCursorRules))), false);
}

/** M7 may send a temperature to this model. */
export function modelTakesTemp(model: string): boolean {
  return callRules((x, mem) => {
    const a = x.po_addr_text();
    return fromBool(x.po_model_takes_temperature(a, putTextOrThrow(mem, a, PO_TEXT_MAX, model)));
  }, false);
}

/** The value of M7_ALLOW_REMOTE_CLASSIFICATION is exactly "true". */
export function remoteClassification(value: string | undefined): boolean {
  return callRules((x, mem) => {
    const a = x.po_addr_text();
    return fromBool(x.po_remote_classification(a, putTextOrThrow(mem, a, PO_TEXT_MAX, value ?? '')));
  }, false);
}
