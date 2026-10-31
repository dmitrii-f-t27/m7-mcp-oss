import { promises as fs, lstatSync, readdirSync, realpathSync } from 'fs';
import * as nodePath from 'path';

/**
 * Path rules for files that cross a trust boundary (SEC-7).
 *
 * Two jobs:
 * - containment: a path must end up inside the project root, also after symlinks
 *   are resolved (`isInside`, `resolveContained`, `guardPath`);
 * - names: some files are never exchanged with a peer or written by a tool
 *   (`pushRefusal`, `pullRefusal`).
 *
 * The decision rules are pure: no I/O, no regular expressions, only byte-level
 * comparisons, so they can move to a t27 spec unchanged. The one exception is
 * `foldUnicode`, marked NATIVE FACADE below: Unicode tables belong to the platform,
 * so it stays native and hands plain folded text to the rules. The I/O functions at
 * the end resolve symlinks and call the rules.
 *
 * Limit: a path is checked, then used. A symlink swapped between the check and the
 * write is not caught.
 */

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

const SLASH = 47; // '/'
const BACKSLASH = 92; // '\'
const UPPER_A = 65;
const UPPER_Z = 90;
const CASE_GAP = 32;

/** Why a path was refused. */
export const REFUSE_NUL = 'the path contains a NUL byte';
export const REFUSE_SECRET = 'a secret or credential file is never exchanged';
export const REFUSE_CONTROL = 'a git, editor or M7 control path is never written from a peer';
export const REFUSE_OUTSIDE = 'the path is outside the project, or leaves it through a symlink';
export const REFUSE_ROOT = 'the project root cannot be resolved';

// The name lists below hold folded text (see `foldName`): lower case, no look-alike
// letters, no ignorable marks, no trailing dots or spaces. A segment is folded before
// it is compared, so `.ENV`, `.cur` + long s + `orrules` and `.env ` all match.

/** Names (whole path segment, folded) that hold secrets. */
const SECRET_NAMES = [
  '.env', '.envrc', '.npmrc', '.netrc', '.pypirc', '.pgpass', '.git-credentials',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials', '.aws', '.ssh', '.docker', '.kube', '.gnupg',
];
/** A segment that starts with one of these holds secrets (`.env.local`). */
const SECRET_PREFIXES = ['.env.'];
/**
 * A segment that ends with one of these holds secrets. `.env` is here because the
 * old push filter blocked `*.env`; it is kept so no protection is lost.
 */
const SECRET_SUFFIXES = ['.key', '.pem', '.p12', '.pfx', '.jks', '.keystore', '.env'];
/** Names (whole path segment, folded) that steer git, editors, agents or M7. */
const CONTROL_NAMES = ['.git', '.cursor', '.cursorrules', '.vscode', '.claude', '.m7', '.husky', '.github', '.mcp.json'];

function isSeparator(code: number, win: boolean): boolean {
  return code === SLASH || (win && code === BACKSLASH);
}

function foldAscii(code: number): number {
  return code >= UPPER_A && code <= UPPER_Z ? code + CASE_GAP : code;
}

// --- NATIVE FACADE: Unicode folding --------------------------------------------
// Not ported to t27. Normalization, case tables and the Default_Ignorable_Code_Point
// property come from the platform (ICU in Node). Everything after this function is
// plain code-unit comparison.

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

// --- Pure rules again -----------------------------------------------------------

const DOT = 46; // '.'
const SPACE = 32; // ' '

/** Cut trailing dots and spaces. Windows and some network file systems ignore them in a name. */
export function trimTrailingDotSpace(text: string): string {
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code !== DOT && code !== SPACE) break;
    end--;
  }
  return text.slice(0, end);
}

/** The comparison key of one path segment: folded, without trailing dots and spaces. */
export function foldName(segment: string): string {
  return trimTrailingDotSpace(foldUnicode(segment));
}

/** Path segments. Both `/` and `\` separate, whatever the platform: the stricter reading. */
export function pathSegments(rel: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let i = 0; i <= rel.length; i++) {
    if (i === rel.length || isSeparator(rel.charCodeAt(i), true)) {
      if (i > start) segments.push(rel.slice(start, i));
      start = i + 1;
    }
  }
  return segments;
}

/** `folded` is the output of `foldName`. */
function isSecretSegment(folded: string): boolean {
  if (SECRET_NAMES.includes(folded)) return true;
  for (const prefix of SECRET_PREFIXES) if (folded.startsWith(prefix)) return true;
  for (const suffix of SECRET_SUFFIXES) if (folded.endsWith(suffix)) return true;
  return false;
}

/** `folded` is the output of `foldName`. */
function isControlSegment(folded: string): boolean {
  return CONTROL_NAMES.includes(folded);
}

/** A reason when `rel` must not be pushed to a peer, otherwise null. */
export function pushRefusal(rel: string): string | null {
  if (rel.indexOf('\0') !== -1) return REFUSE_NUL;
  for (const segment of pathSegments(rel)) {
    if (isSecretSegment(foldName(segment))) return REFUSE_SECRET;
  }
  return null;
}

/** A reason when `rel` must not be written into the project, otherwise null. */
export function pullRefusal(rel: string): string | null {
  const secret = pushRefusal(rel);
  if (secret !== null) return secret;
  for (const segment of pathSegments(rel)) {
    if (isControlSegment(foldName(segment))) return REFUSE_CONTROL;
  }
  return null;
}

/**
 * True when `target` is `root` or lies below it: equal, or `root` plus a separator
 * as prefix. A bare prefix is not enough (`/a/b-evil` is not inside `/a/b`).
 * `win` turns on the Windows reading: both separators, ASCII case-insensitive.
 */
export function isInsideWith(root: string, target: string, win: boolean): boolean {
  const n = root.length;
  if (n === 0 || target.length < n) return false;
  for (let i = 0; i < n; i++) {
    const a = root.charCodeAt(i);
    const b = target.charCodeAt(i);
    if (a === b) continue;
    if (win && isSeparator(a, true) && isSeparator(b, true)) continue;
    if (win && foldAscii(a) === foldAscii(b)) continue;
    return false;
  }
  if (target.length === n) return true;
  if (isSeparator(root.charCodeAt(n - 1), win)) return true;
  return isSeparator(target.charCodeAt(n), win);
}

export function isInside(root: string, target: string): boolean {
  return isInsideWith(root, target, process.platform === 'win32');
}

/** `target` relative to `root` when it is inside, otherwise null. */
export function relativeWithin(root: string, target: string): string | null {
  if (!isInside(root, target)) return null;
  let i = root.length;
  while (i < target.length && isSeparator(target.charCodeAt(i), process.platform === 'win32')) i++;
  return target.slice(i);
}

/**
 * True when a symlink that resolves to `real` leaves `realRoot` (SEC-26). `real` is null
 * when the link dangles, which counts as leaving: the target can be created later.
 */
export function linkLeavesRoot(realRoot: string, real: string | null): boolean {
  return real === null || !isInside(realRoot, real);
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
  return name !== '' && name !== '.' && name !== '..' && name.indexOf('\0') === -1;
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
 * Each folder is walked without following links. The folder itself, or any link below it,
 * that resolves outside `realpath(root)` or dangles is refused. A link that stays inside
 * the project is fine; it is not followed, so a link behind it is not looked at. More than
 * DATA_DIR_MAX_ENTRIES entries in all are refused, and so are a folder that cannot be read
 * and a root that cannot be resolved. A folder that is absent passes.
 *
 * Limit: the folders are checked, then used. A link planted after the check is not caught.
 */
export function dataDirRefusal(root: string, dirs: readonly string[]): string | null {
  const realRoot = realpathOrNull(root);
  if (realRoot === null) return refuseDataDir(root, ' (the project root cannot be resolved)');

  let entries = 0;
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
          if (linkLeavesRoot(realRoot, realpathOrNull(full))) return refuseDataDir(full);
        } else if (entry.isDirectory()) {
          pending.push(full);
        }
      }
    }
  }
  return null;
}
