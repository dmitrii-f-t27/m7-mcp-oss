// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
import { promises as fs, lstatSync, readdirSync, realpathSync } from 'fs';
import * as nodePath from 'path';
import {
  REFUSE_BAD_TEXT, REFUSE_CONTROL, REFUSE_NUL, REFUSE_RULES, REFUSE_SECRET, REFUSE_TOO_LONG,
  insideWith, linkLeaves, plainEntryName, pullVerdict, pushVerdict, relativeFrom, splitSegments, trimEnd,
} from '../../rules/pathRules.js';

/**
 * Path rules for files that cross a trust boundary (SEC-7).
 *
 * Two jobs:
 * - containment: a path must end up inside the project root, also after symlinks
 *   are resolved (`isInside`, `resolveContained`, `guardPath`);
 * - names: some files are never exchanged with a peer or written by a tool
 *   (`pushRefusal`, `pullRefusal`).
 *
 * The decision rules are written in t27 (specs/path_rules.t27, specs/path_tables.t27,
 * specs/bytes_rules.t27) and run as WebAssembly. The functions below that were rules are
 * one-line calls into src/rules/pathRules.ts, which writes the text into the wasm and reads the
 * answer. If the wasm is missing or fails, they give the refusing answer of their rule
 * (`REFUSE_RULES`, `false` for containment, `true` for a link that leaves the root).
 * Text over 4096 bytes (a verdict: over 16384 bytes after folding) and text with a lone
 * surrogate are refused too: a rule never decides on a cut or a changed text.
 *
 * Two parts stay native. `foldUnicode` (marked NATIVE FACADE below): Unicode tables belong to
 * the platform, so it hands plain folded text to the rules. The I/O functions at the end
 * resolve symlinks and call the rules.
 *
 * Limit: a path is checked, then used. A symlink swapped between the check and the
 * write is not caught.
 */

// ---------------------------------------------------------------------------
// Rules (specs/path_rules.t27)
// ---------------------------------------------------------------------------

/** Why a path was refused. */
export { REFUSE_BAD_TEXT, REFUSE_CONTROL, REFUSE_NUL, REFUSE_RULES, REFUSE_SECRET, REFUSE_TOO_LONG };
export const REFUSE_OUTSIDE = 'the path is outside the project, or leaves it through a symlink';
export const REFUSE_ROOT = 'the project root cannot be resolved';

// --- NATIVE FACADE: Unicode folding --------------------------------------------
// Not ported to t27. Normalization, case tables and the Default_Ignorable_Code_Point
// property come from the platform (ICU in Node). The folded text goes to the rules as bytes.

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * NATIVE FACADE. Fold one path segment the way a case-insensitive file system
 * compares names, so a look-alike spelling meets the same denylist entry:
 * - ignorable code points are dropped (zero-width space, soft hyphen, word joiner,
 *   byte order mark, variation selectors, tag characters);
 * - NFKC turns compatibility forms into plain ones (long s -> s, full-width letters
 *   and full stop, ligatures);
 * - upper case, then lower case: the Kelvin sign becomes k, the sharp s becomes ss,
 *   the dotless i becomes i.
 * The result is for comparison only; it is never used as a path.
 */
export function foldUnicode(text: string): string {
  return text.replace(IGNORABLE, '').normalize('NFKC').toUpperCase().toLowerCase().replace(IGNORABLE, '');
}

/** Cut trailing dots and spaces. Windows and some network file systems ignore them in a name. On a failure the text stays as it is. */
export function trimTrailingDotSpace(text: string): string {
  return trimEnd(text);
}

/** The comparison key of one path segment: folded, without trailing dots and spaces. */
export function foldName(segment: string): string {
  return trimTrailingDotSpace(foldUnicode(segment));
}

/** Path segments. Both `/` and `\` separate, whatever the platform: the stricter reading. Throws if the rules cannot split the text. */
export function pathSegments(rel: string): string[] {
  return splitSegments(rel);
}

/** A reason when `rel` must not be pushed to a peer, otherwise null. */
export function pushRefusal(rel: string): string | null {
  return pushVerdict(rel, foldUnicode);
}

/** A reason when `rel` must not be written into the project, otherwise null. */
export function pullRefusal(rel: string): string | null {
  return pullVerdict(rel, foldUnicode);
}

/**
 * True when `target` is `root` or lies below it: equal, or `root` plus a separator
 * as prefix. A bare prefix is not enough (`/a/b-evil` is not inside `/a/b`).
 * `win` turns on the Windows reading: both separators, ASCII case-insensitive.
 */
export function isInsideWith(root: string, target: string, win: boolean): boolean {
  return insideWith(root, target, win);
}

export function isInside(root: string, target: string): boolean {
  return isInsideWith(root, target, process.platform === 'win32');
}

/** `target` relative to `root` when it is inside, otherwise null. */
export function relativeWithin(root: string, target: string): string | null {
  return relativeFrom(root, target, process.platform === 'win32');
}

/**
 * True when a symlink that resolves to `real` leaves `realRoot` (SEC-26). `real` is null
 * when the link dangles, which counts as leaving: the target can be created later.
 */
export function linkLeavesRoot(realRoot: string, real: string | null): boolean {
  return linkLeaves(realRoot, real, process.platform === 'win32');
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// On success `abs` is the path with symlinks resolved, and it lies inside `realRoot`.
type Resolved =
  | { ok: true; realRoot: string; abs: string }
  | { ok: false; reason: string };

async function resolveParts(root: string, rel: string): Promise<Resolved> {
  if (root.indexOf('\0') !== -1 || rel.indexOf('\0') !== -1) return { ok: false, reason: REFUSE_NUL };

  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return { ok: false, reason: REFUSE_ROOT };
  }
  const outside: Resolved = { ok: false, reason: REFUSE_OUTSIDE };

  // Resolve against the root as given: a relative path stays under it, and an
  // absolute path may name the project by either its given or its real spelling.
  const givenRoot = nodePath.resolve(root);
  const abs = nodePath.resolve(givenRoot, rel);
  if (!isInside(givenRoot, abs) && !isInside(realRoot, abs)) return outside;

  // Follow symlinks on the nearest ancestor that exists, and check again.
  // A dangling symlink, or any error other than "not there", refuses the path.
  let ancestor = abs;
  for (;;) {
    try {
      const realAncestor = await fs.realpath(ancestor);
      if (!isInside(realRoot, realAncestor)) return outside;
      return { ok: true, realRoot, abs: nodePath.join(realAncestor, abs.slice(ancestor.length)) };
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return outside;
    }
    try {
      await fs.lstat(ancestor);
      return outside; // exists as a link whose target is missing
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return outside;
    }
    const parent = nodePath.dirname(ancestor);
    if (parent === ancestor) return outside;
    ancestor = parent;
  }
}

/**
 * The real path of `rel` under `root`, or null when it is not contained: it leaves
 * the root lexically, or the nearest existing ancestor resolves outside the root.
 * The answer is the path to use for the file operation, not the string passed in.
 */
export async function resolveContained(root: string, rel: string): Promise<string | null> {
  const parts = await resolveParts(root, rel);
  return parts.ok ? parts.abs : null;
}

/** True when `name` can be joined to a directory: not empty, not `.` or `..`, no NUL. */
export function isPlainEntryName(name: string): boolean {
  return plainEntryName(name);
}

/**
 * The real path to use for the file `rel` under `root`, or null. The parent directory
 * is resolved and must lie inside the root (see `resolveContained`), also through
 * symlinks. The last component is NOT followed: it is returned as named, so a symlink
 * there stays visible to the caller (`wx`, `O_NOFOLLOW` and `lstat` still see it). Use
 * this for a file that M7 creates, appends to or rewrites, where the file itself being a
 * link must not be followed either. `rel` that ends in `.` or `..` is refused.
 */
export async function resolveContainedEntry(root: string, rel: string): Promise<string | null> {
  const name = nodePath.basename(rel);
  if (!isPlainEntryName(name)) return null;
  const dir = await resolveContained(root, nodePath.dirname(rel));
  return dir === null ? null : nodePath.join(dir, name);
}

export type GuardResult =
  | { ok: true; abs: string; relative: string }
  | { ok: false; reason: string };

/**
 * `refusal` is `pushRefusal` or `pullRefusal`. The name rule runs on the given path
 * and again on the real relative path, so a symlink with an innocent name cannot
 * reach `.env` or `.git/hooks`. On success `abs` is the path to use.
 */
export async function guardPath(
  root: string,
  rel: string,
  refusal: (rel: string) => string | null,
): Promise<GuardResult> {
  const given = refusal(rel);
  if (given !== null) return { ok: false, reason: given };

  const parts = await resolveParts(root, rel);
  if (!parts.ok) return { ok: false, reason: parts.reason };

  const relative = relativeWithin(parts.realRoot, parts.abs);
  if (relative === null) return { ok: false, reason: REFUSE_OUTSIDE };
  const real = refusal(relative);
  if (real !== null) return { ok: false, reason: real };

  return { ok: true, abs: parts.abs, relative };
}

// ---------------------------------------------------------------------------
// M7 data folders (SEC-26)
// ---------------------------------------------------------------------------

/** The folders the server writes to under the project root without a path from the caller. */
export const M7_DATA_DIRS: readonly string[] = ['.m7', 'm7-cycles'];

/** A data folder tree with more entries than this is not walked: it is refused. */
export const DATA_DIR_MAX_ENTRIES = 20000;

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function refuseDataDir(where: string, note = ''): string {
  return `Refusing to write outside the project: ${where}${note}`;
}

/**
 * A refusal text when one of the data folders `dirs` (names under `root`) leads outside
 * the project, otherwise null. A cloned repo can ship `.m7` or `m7-cycles` as a symlink,
 * and everything M7 writes there would land in the folder the link names.
 *
 * Each folder is walked. The folder itself, or any link below it, that resolves outside
 * `realpath(root)` or dangles is refused. A link that stays inside the project and names a
 * folder is followed: its real path is walked too, once, so a link behind it is found
 * (`.m7/a -> ../y` with `y/out -> /elsewhere`), and links that loop end at a folder already
 * seen. A link to a file inside the project is fine. More than DATA_DIR_MAX_ENTRIES entries
 * in all, the entries behind followed links included, are refused, and so are a folder that
 * cannot be read and a root that cannot be resolved. A folder that is absent passes.
 *
 * Limit: the folders are checked, then used. A link planted after the check is not caught.
 */
export function dataDirRefusal(root: string, dirs: readonly string[]): string | null {
  const realRoot = realpathOrNull(root);
  if (realRoot === null) return refuseDataDir(root, ' (the project root cannot be resolved)');

  let entries = 0;
  // Real paths of the folders already walked or queued. A link to one of them is not
  // walked again, so a loop of links ends and a folder is not counted twice.
  const seen = new Set<string>();
  for (const dir of dirs) {
    const start = nodePath.join(realRoot, dir);
    let top = start;
    try {
      if (lstatSync(start).isSymbolicLink()) {
        const real = realpathOrNull(start);
        if (real === null || linkLeavesRoot(realRoot, real)) return refuseDataDir(start);
        top = real;
      }
      if (!lstatSync(top).isDirectory()) continue;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      return refuseDataDir(start);
    }
    if (seen.has(top)) continue;
    seen.add(top);

    const pending = [top];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      let listing;
      try {
        listing = readdirSync(current, { withFileTypes: true });
      } catch {
        return refuseDataDir(current);
      }
      for (const entry of listing) {
        entries++;
        if (entries > DATA_DIR_MAX_ENTRIES) {
          return refuseDataDir(start, ` (more than ${DATA_DIR_MAX_ENTRIES} entries, cannot be checked)`);
        }
        const full = nodePath.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          const real = realpathOrNull(full);
          if (real === null || linkLeavesRoot(realRoot, real)) return refuseDataDir(full);
          // The link stays inside the project. Walk the folder it names, once.
          let isFolder: boolean;
          try {
            isFolder = lstatSync(real).isDirectory();
          } catch {
            return refuseDataDir(full);
          }
          if (isFolder && !seen.has(real)) {
            seen.add(real);
            pending.push(real);
          }
        } else if (entry.isDirectory() && !seen.has(full)) {
          seen.add(full);
          pending.push(full);
        }
      }
    }
  }
  return null;
}
