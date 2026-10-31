import { constants as fsConstants, promises as fs } from 'fs';
import { resolveContainedEntry } from '../security/pathGuard.js';

/**
 * Rules for writing into a user's project (SEC-2).
 *
 * M7 may create a project file that is absent. It may change a file later only
 * when the file carries M7_MANAGED_MARKER in its first MANAGED_SCAN_BYTES bytes.
 * Everything else is the user's file: M7 skips it. Most tools list the skipped file in
 * their answer; a skipped memory-bank/activeContext.md only gets a debug log line.
 *
 * The decision rules below are pure (no I/O). The functions at the end do the I/O.
 */

/** Written into templates M7 appends to or rewrites later. */
export const M7_MANAGED_MARKER = '<!-- m7-managed -->';

/** The marker must start and end inside this many leading bytes. */
export const MANAGED_SCAN_BYTES = 4096;

export type WriteOutcome = 'created' | 'skipped';
export type ManagedState = 'absent' | 'managed' | 'foreign';
export type ManagedWriteAction = 'create' | 'update' | 'skip';
export type ManagedSyncAction = 'sync' | 'skip';

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** True when the marker lies fully inside the first MANAGED_SCAN_BYTES bytes of `content`. */
export function hasManagedMarker(content: string | Buffer): boolean {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return bytes.subarray(0, MANAGED_SCAN_BYTES).includes(M7_MANAGED_MARKER);
}

/** `head` is the start of the file, or null when the file does not exist. */
export function managedStateOf(head: Buffer | null): ManagedState {
  if (head === null) return 'absent';
  return hasManagedMarker(head) ? 'managed' : 'foreign';
}

/** What M7 may do with a file in this state. */
export function managedWriteAction(state: ManagedState): ManagedWriteAction {
  if (state === 'absent') return 'create';
  if (state === 'managed') return 'update';
  return 'skip';
}

/**
 * What M7 may do when it syncs a note into an existing reference file:
 * only a file M7 manages is changed. A missing file is not created.
 */
export function managedSyncAction(state: ManagedState): ManagedSyncAction {
  return state === 'managed' ? 'sync' : 'skip';
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Create `absPath` with `content` only when nothing is there.
 * `flag: 'wx'` fails on any existing entry, also on a symlink (dangling or not),
 * and leaves no gap between the check and the write.
 */
export async function writeIfAbsent(absPath: string, content: string): Promise<WriteOutcome> {
  try {
    await fs.writeFile(absPath, content, { encoding: 'utf-8', flag: 'wx' });
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'skipped';
    throw error;
  }
}

/** True when anything exists at `absPath`, a symlink (also a dangling one) included. */
export async function pathExistsNoFollow(absPath: string): Promise<boolean> {
  try {
    await fs.lstat(absPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * True when the last component of `absPath` is a symlink, dangling or not. A missing
 * path is not a symlink. Fails closed: an error other than "not there" counts as a link,
 * so the caller refuses to write.
 */
export async function isSymlinkNoFollow(absPath: string): Promise<boolean> {
  try {
    return (await fs.lstat(absPath)).isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Read the state of a file from disk. Fails closed: a symlink, a directory or a
 * file that cannot be read is 'foreign'. Only a missing file is 'absent'.
 */
export async function readManagedState(absPath: string): Promise<ManagedState> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(absPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? managedStateOf(null) : 'foreign';
  }
  try {
    if (!(await handle.stat()).isFile()) return 'foreign';
    const buffer = Buffer.alloc(MANAGED_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MANAGED_SCAN_BYTES, 0);
    return managedStateOf(buffer.subarray(0, bytesRead));
  } catch {
    return 'foreign';
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Write `content` to a file M7 manages: create it when absent, replace it when it
 * carries the marker, leave it alone otherwise.
 */
export async function writeManagedFile(
  absPath: string,
  content: string,
): Promise<'created' | 'updated' | 'skipped'> {
  const action = managedWriteAction(await readManagedState(absPath));
  if (action === 'skip') return 'skipped';
  if (action === 'create') return writeIfAbsent(absPath, content);
  await fs.writeFile(absPath, content, 'utf-8');
  return 'updated';
}

/**
 * Write `content` to the file `rel` under `root` (SEC-32). Throws, and writes nothing, when the
 * folder above the file leaves the project (`resolveContainedEntry`, also through symlinks) or
 * when the file itself is a symlink, dangling or not. An absent file is created and a regular
 * file is replaced. Use it for a project file M7 rewrites that is not a data folder entry.
 *
 * Limit: the check and the write are two steps. A link planted between them is not caught.
 */
export async function writeRegularFile(root: string, rel: string, content: string): Promise<void> {
  const abs = await resolveContainedEntry(root, rel);
  if (abs === null) throw new Error(`Refusing to write outside the project: ${rel}`);
  if (await isSymlinkNoFollow(abs)) throw new Error(`Refusing to write ${rel}: it is a symbolic link`);
  await fs.writeFile(abs, content, 'utf-8');
}

/** Append `entry` only to an existing file that carries the marker. */
export async function appendIfManaged(absPath: string, entry: string): Promise<'appended' | 'not-synced'> {
  if (managedSyncAction(await readManagedState(absPath)) !== 'sync') return 'not-synced';
  await fs.appendFile(absPath, entry, 'utf-8');
  return 'appended';
}

/**
 * Rewrite an existing file that carries the marker with `transform(current text)`.
 * Any other file, and a missing file, is left alone.
 */
export async function updateIfManaged(
  absPath: string,
  transform: (existing: string) => string,
): Promise<'updated' | 'not-synced'> {
  if (managedSyncAction(await readManagedState(absPath)) !== 'sync') return 'not-synced';
  const existing = await fs.readFile(absPath, 'utf-8');
  await fs.writeFile(absPath, transform(existing), 'utf-8');
  return 'updated';
}
