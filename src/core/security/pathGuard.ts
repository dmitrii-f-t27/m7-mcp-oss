import { promises as fs } from 'fs';
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
 * comparisons, so they can move to a t27 spec unchanged. The I/O functions at the
 * end resolve symlinks and call the rules.
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

/** Names (whole path segment, ASCII case-insensitive) that hold secrets. */
const SECRET_NAMES = [
  '.env', '.npmrc', '.netrc', '.pypirc',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials', '.aws', '.ssh',
];
/** A segment that starts with one of these holds secrets (`.env.local`). */
const SECRET_PREFIXES = ['.env.'];
/**
 * A segment that ends with one of these holds secrets. `.env` is here because the
 * old push filter blocked `*.env`; it is kept so no protection is lost.
 */
const SECRET_SUFFIXES = ['.key', '.pem', '.p12', '.pfx', '.jks', '.keystore', '.env'];
/** Names (whole path segment, ASCII case-insensitive) that steer git, editors, agents or M7. */
const CONTROL_NAMES = ['.git', '.cursor', '.cursorrules', '.vscode', '.claude', '.m7', '.husky', '.github'];

function isSeparator(code: number, win: boolean): boolean {
  return code === SLASH || (win && code === BACKSLASH);
}

function foldAscii(code: number): number {
  return code >= UPPER_A && code <= UPPER_Z ? code + CASE_GAP : code;
}

/** ASCII upper case to lower case; every other code unit stays. */
export function asciiLower(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code >= UPPER_A && code <= UPPER_Z ? String.fromCharCode(code + CASE_GAP) : text[i];
  }
  return out;
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

function isSecretSegment(lower: string): boolean {
  if (SECRET_NAMES.includes(lower)) return true;
  for (const prefix of SECRET_PREFIXES) if (lower.startsWith(prefix)) return true;
  for (const suffix of SECRET_SUFFIXES) if (lower.endsWith(suffix)) return true;
  return false;
}

/** A reason when `rel` must not be pushed to a peer, otherwise null. */
export function pushRefusal(rel: string): string | null {
  if (rel.indexOf('\0') !== -1) return REFUSE_NUL;
  for (const segment of pathSegments(rel)) {
    if (isSecretSegment(asciiLower(segment))) return REFUSE_SECRET;
  }
  return null;
}

/** A reason when `rel` must not be written into the project, otherwise null. */
export function pullRefusal(rel: string): string | null {
  const secret = pushRefusal(rel);
  if (secret !== null) return secret;
  for (const segment of pathSegments(rel)) {
    if (CONTROL_NAMES.includes(asciiLower(segment))) return REFUSE_CONTROL;
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
