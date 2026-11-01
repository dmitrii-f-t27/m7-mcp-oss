// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Facade of the path rules (specs/path_rules.t27, specs/path_tables.t27, specs/bytes_rules.t27).
 *
 * This file decides nothing about a path. It writes text into the wasm buffers, calls the rule with the
 * true length, reads the answer, and gives the refusing value of the rule when anything goes wrong:
 * the wasm is not available, a call traps, the text does not fit (over 4096 bytes, over 16384 bytes after
 * folding), the text has a lone surrogate (UTF-8 cannot carry one: `encodeInto` would write U+FFFD and two
 * different texts could become equal), or the wasm answers a number the facade does not know.
 *
 * What stays native here: the Unicode folding of each segment (the platform owns the tables, so the caller
 * passes `foldUnicode`), `resolve()` for the current-project check, and the loops that walk the answers.
 *
 * Refusing values (callers: src/core/security/pathGuard.ts, src/core/utils/projectPath.ts):
 *   verdicts REFUSE_RULES, containment false, relative part null, link leaves root true, plain entry
 *   name false, unsafe fallback true, needs switch true, project source throws, trim unchanged text.
 */

import { resolve } from 'path';

import type { EnvProjectSourceFacts } from '../core/utils/projectPath.js';
import { PR_FOLDED_MAX, PR_PATH_MAX, PR_VERDICT_CONTROL, PR_VERDICT_OK, PR_VERDICT_SECRET } from './generated/constants.js';
import { checkBool, fromBool, isWellFormedText, putText } from './marshal.js';
import { callRules, callRulesOrThrow } from './wasm.js';
import type { RulesExports } from './wasm.js';

/** Why a path was refused. */
export const REFUSE_NUL = 'the path contains a NUL byte';
export const REFUSE_SECRET = 'a secret or credential file is never exchanged';
export const REFUSE_CONTROL = 'a git, editor or M7 control path is never written from a peer';
export const REFUSE_TOO_LONG = 'the path is too long for the rules to check: the limit is 4096 bytes, and 16384 bytes after folding';
export const REFUSE_BAD_TEXT = 'the path is not valid text: it holds a lone surrogate';
export const REFUSE_RULES = 'the path rules are not available';

/** The text is refused for a reason that is not a failure of the rules. */
class PathRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

// ignoreBOM: a text that starts with U+FEFF keeps it (the default decoder would drop it as a byte order mark).
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Write `text` at `ptr`. Returns its length in bytes. Throws PathRefusal for a lone surrogate or text over `cap`. */
function putPath(mem: Uint8Array, ptr: number, text: string, cap: number = PR_PATH_MAX): number {
  if (!isWellFormedText(text)) throw new PathRefusal(REFUSE_BAD_TEXT);
  const length = putText(mem, ptr, cap, text);
  if (length < 0) throw new PathRefusal(REFUSE_TOO_LONG);
  return length;
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/** `target` is `root` or lies below it. */
export function insideWith(root: string, target: string, win: boolean): boolean {
  return callRules((x, mem) => {
    const a = x.pr_addr_a();
    const b = x.pr_addr_b();
    const rootLen = putPath(mem, a, root);
    const targetLen = putPath(mem, b, target);
    return fromBool(x.pr_is_inside(a, rootLen, b, targetLen, checkBool(Number(win))));
  }, false);
}

/** `target` relative to `root` when it is inside, otherwise null. */
export function relativeFrom(root: string, target: string, win: boolean): string | null {
  return callRules((x, mem) => {
    const a = x.pr_addr_a();
    const b = x.pr_addr_b();
    const rootLen = putPath(mem, a, root);
    const targetLen = putPath(mem, b, target);
    const start = x.pr_relative_start(a, rootLen, b, targetLen, checkBool(Number(win)));
    if (start === -1) return null;
    if (start < rootLen || start > targetLen) throw new RangeError(`pr_relative_start answered ${start}`);
    return decoder.decode(mem.subarray(b + start, b + targetLen));
  }, null);
}

/** A link that resolves to `real` leaves `realRoot`; `real` is null when it dangles. */
export function linkLeaves(realRoot: string, real: string | null, win: boolean): boolean {
  const inside = insideWith(realRoot, real ?? '', win);
  return callRules(x => fromBool(x.pr_link_leaves(Number(real === null), Number(inside))), true);
}

/** `name` can be joined to a directory. */
export function plainEntryName(name: string): boolean {
  return callRules((x, mem) => {
    const a = x.pr_addr_a();
    return fromBool(x.pr_plain_entry_name(a, putPath(mem, a, name)));
  }, false);
}

// ---------------------------------------------------------------------------
// Segments and verdicts
// ---------------------------------------------------------------------------

/** The byte ranges [start, end) of the path segments of the text at `a`, from the rules. */
function segmentRanges(x: RulesExports, a: number, len: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let pos = 0;
  // Every pass moves pos forward by at least one byte, so len + 1 passes are enough; a backend that does not
  // stop is an error, not an endless loop.
  for (let pass = 0; pass <= len; pass++) {
    const start = x.pr_seg_start(a, len, pos);
    if (start === -1) return ranges;
    if (start < pos || start >= len) throw new RangeError(`pr_seg_start answered ${start} from ${pos} in ${len} bytes`);
    const end = x.pr_seg_end(a, len, start);
    if (end <= start || end > len) throw new RangeError(`pr_seg_end answered ${end} from ${start} in ${len} bytes`);
    ranges.push([start, end]);
    pos = end;
  }
  throw new RangeError(`the segment scan did not stop within ${len + 1} passes`);
}

/** The segments of `rel`, split at "/" and "\". Throws if the rules cannot split the text. */
export function splitSegments(rel: string): string[] {
  return callRulesOrThrow((x, mem) => {
    const a = x.pr_addr_a();
    const len = putPath(mem, a, rel);
    return segmentRanges(x, a, len).map(([start, end]) => decoder.decode(mem.subarray(a + start, a + end)));
  });
}

/** `text` without trailing dots and spaces. The text stays as it is when the rules cannot do it. */
export function trimEnd(text: string): string {
  return callRules((x, mem) => {
    const s = x.pr_addr_seg();
    const length = putPath(mem, s, text, PR_FOLDED_MAX);
    const kept = x.pr_trim_end(s, length);
    if (kept < 0 || kept > length) throw new RangeError(`pr_trim_end answered ${kept} for ${length} bytes`);
    return decoder.decode(mem.subarray(s, s + kept));
  }, text);
}

/**
 * Fold each segment of the text at `a` with `fold`, cut its trailing dots and spaces with the rules, and
 * write the results one after the other, each followed by a NUL byte, to the joined buffer. Returns the
 * length of the joined text. The split comes before the fold, as before: a full-width solidus stays in its segment.
 */
function joinFolded(x: RulesExports, mem: Uint8Array, a: number, len: number, fold: (segment: string) => string): number {
  const s = x.pr_addr_seg();
  const j = x.pr_addr_joined();
  let used = 0;
  for (const [start, end] of segmentRanges(x, a, len)) {
    const length = putPath(mem, s, fold(decoder.decode(mem.subarray(a + start, a + end))), PR_FOLDED_MAX);
    if (fromBool(x.pr_has_nul(s, length))) throw new RangeError('folding made a NUL byte');
    const kept = x.pr_trim_end(s, length);
    if (kept < 0 || kept > length) throw new RangeError(`pr_trim_end answered ${kept} for ${length} bytes`);
    if (used + kept + 1 > PR_FOLDED_MAX) throw new PathRefusal(REFUSE_TOO_LONG);
    mem.copyWithin(j + used, s, s + kept);
    mem[j + used + kept] = 0;
    used += kept + 1;
  }
  return used;
}

const VERDICT_REASON: Record<number, string | null> = {
  [PR_VERDICT_OK]: null,
  [PR_VERDICT_SECRET]: REFUSE_SECRET,
  [PR_VERDICT_CONTROL]: REFUSE_CONTROL,
};

/** NUL check, well-formed check, split, fold each segment, join with NUL, ask the rules. */
function verdict(rel: string, pull: boolean, fold: (segment: string) => string): string | null {
  return callRules((x, mem): string | null => {
    try {
      const a = x.pr_addr_a();
      const len = putPath(mem, a, rel);
      if (fromBool(x.pr_has_nul(a, len))) return REFUSE_NUL;
      const joined = joinFolded(x, mem, a, len, fold);
      const j = x.pr_addr_joined();
      const code = pull ? x.pr_pull_verdict(j, joined) : x.pr_push_verdict(j, joined);
      const reason = VERDICT_REASON[code];
      if (reason === undefined) throw new RangeError(`the verdict answered ${code}`);
      return reason;
    } catch (e) {
      if (e instanceof PathRefusal) return e.reason;
      throw e;
    }
  }, REFUSE_RULES);
}

/** A reason when `rel` must not be pushed to a peer, otherwise null. `fold` is the Unicode fold of one segment. */
export function pushVerdict(rel: string, fold: (segment: string) => string): string | null {
  return verdict(rel, false, fold);
}

/** A reason when `rel` must not be written into the project, otherwise null. */
export function pullVerdict(rel: string, fold: (segment: string) => string): string | null {
  return verdict(rel, true, fold);
}

// ---------------------------------------------------------------------------
// Project path
// ---------------------------------------------------------------------------

/**
 * Which source answers after explicit project_path and MCP Roots. `names` maps the PR_SRC_* number that the
 * rules answer to the name of the source; it lives next to the type in projectPath.ts. Throws if the rules
 * cannot say, or answer a number that has no name.
 */
export function selectSource<T>(facts: EnvProjectSourceFacts, names: Record<number, T>): T {
  return callRulesOrThrow(x => {
    const code = x.pr_env_source(
      Number(Boolean(facts.hasCursorEnv)),
      Number(Boolean(facts.hasAgentTranscripts)),
      Number(Boolean(facts.hasValidM7Path)),
      Number(Boolean(facts.rootsComplete)),
      Number(Boolean(facts.cwdAllowsScan)),
    );
    const source = names[code];
    if (source === undefined) throw new RangeError(`pr_env_source answered ${code}`);
    return source;
  });
}

/** Must a subscriber that works on `current` switch to `next`? Both are resolved first. True when the rules fail. */
export function needsSwitch(current: string | null, next: string): boolean {
  const [cur, nxt] = current === null ? ['', ''] : [resolve(current), resolve(next)];
  return callRules((x, mem) => {
    const a = x.pr_addr_a();
    const b = x.pr_addr_b();
    const curLen = putPath(mem, a, cur);
    const nxtLen = putPath(mem, b, nxt);
    return fromBool(x.pr_needs_switch(Number(current !== null), a, curLen, b, nxtLen));
  }, true);
}

/**
 * The home folder is not a project unless it holds a project marker. `isValid` is only asked for the home
 * folder: for any other folder the answer does not depend on it. True when the rules fail.
 */
export function unsafeFallback(isHome: boolean, isValid: () => boolean): boolean {
  const valid = isHome ? isValid() : false;
  return callRules(x => fromBool(x.pr_unsafe_fallback(Number(isHome), Number(valid))), true);
}
