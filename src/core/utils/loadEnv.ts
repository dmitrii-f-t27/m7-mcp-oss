import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

/**
 * The one `.env` file M7 reads: the file in its install directory, which is the
 * parent of `dist/`. The server never reads a `.env` from its working
 * directory, because that directory is chosen by the MCP client config and can
 * be an untrusted project folder.
 *
 * Pure. `entryModuleUrl` is `import.meta.url` of `dist/index.js`.
 */
export function resolveInstallEnvPath(entryModuleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(entryModuleUrl)), '..', '.env');
}

/**
 * Load the install-directory `.env` into `target` (the process environment by
 * default). A variable that is already set is kept: the process environment
 * wins over the file. A missing file is not an error.
 */
export function loadInstallEnv(
  entryModuleUrl: string,
  target: Record<string, string> = process.env as Record<string, string>
): void {
  dotenv.config({ path: resolveInstallEnvPath(entryModuleUrl), processEnv: target, quiet: true });
}
