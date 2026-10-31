#!/usr/bin/env node
/**
 * Adds the "m7" server to a Cursor MCP config file and keeps everything else.
 *
 * Usage: node scripts/merge-cursor-config.mjs <path to mcp.json> <M7 install directory>
 *
 * - File missing: it is created, with its directory, holding only the m7 entry.
 * - File valid: mcpServers.m7 is added or replaced. Every other server and
 *   every other top-level key stays as it was.
 * - File not mergeable (not JSON, not an object, or "mcpServers" is not an
 *   object): nothing is written and the file is left as it was.
 * - No API key is written. The server reads the `.env` in its install
 *   directory (see SECURITY.md), so the config needs no `env` block.
 *
 * Exit codes: 0 done, 1 wrong usage, 2 file not changed (the reason goes to stderr).
 *
 * `install.sh` calls this script. It never reads a default path: the caller
 * names the file, so a test can point it at a temporary file.
 */

import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The config entry for the server in `installDir`. No env block, so no key. */
export function buildM7Entry(installDir) {
  return {
    command: 'node',
    args: [path.join(installDir, 'dist', 'index.js')],
    cwd: installDir,
  };
}

/**
 * Merge the m7 entry into the text of an existing config.
 * @param {string | null} existingText  file content, or null when there is no file
 * @param {string} installDir
 * @returns {{ ok: true, text: string, action: 'created' | 'added' | 'replaced' } | { ok: false, reason: string }}
 */
export function mergeCursorConfig(existingText, installDir) {
  let config = {};
  let action = 'created';

  if (existingText !== null) {
    try {
      config = JSON.parse(existingText);
    } catch (err) {
      return { ok: false, reason: `it is not valid JSON (${err.message})` };
    }
    if (!isPlainObject(config)) {
      return { ok: false, reason: 'its top level is not a JSON object' };
    }
    if ('mcpServers' in config && !isPlainObject(config.mcpServers)) {
      return { ok: false, reason: '"mcpServers" is not a JSON object' };
    }
    action = isPlainObject(config.mcpServers) && 'm7' in config.mcpServers ? 'replaced' : 'added';
  }

  const merged = { ...config, mcpServers: { ...(config.mcpServers ?? {}), m7: buildM7Entry(installDir) } };
  return { ok: true, text: `${JSON.stringify(merged, null, 2)}\n`, action };
}

/** Write through a temporary file in the same directory, so a failure leaves the old file whole. */
function writeAtomically(file, text) {
  // A config that is a symlink (a dotfiles manager does this) keeps its link: write to its target.
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.m7-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    if (existsSync(target)) chmodSync(tmp, statSync(target).mode & 0o777);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function main(args) {
  if (args.length !== 2 || !args[0] || !args[1]) {
    console.error('Usage: node scripts/merge-cursor-config.mjs <path to mcp.json> <M7 install directory>');
    return 1;
  }
  const file = path.resolve(args[0]);
  const installDir = path.resolve(args[1]);
  const refuse = reason => {
    console.error(`merge-cursor-config: ${file} was not changed: ${reason}.`);
    console.error('Fix or remove that file, then run this again. Or add the "m7" server by hand (see README.md).');
    return 2;
  };

  let existing = null;
  try {
    existing = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') return refuse(`it could not be read (${err.code ?? err.message})`);
  }

  const merged = mergeCursorConfig(existing, installDir);
  if (!merged.ok) return refuse(merged.reason);

  try {
    writeAtomically(file, merged.text);
  } catch (err) {
    return refuse(`it could not be written (${err.code ?? err.message})`);
  }
  console.log(`${{ created: 'Created', added: 'Added m7 to', replaced: 'Replaced the m7 entry in' }[merged.action]} ${file}`);
  return 0;
}

// Run only when started from the command line, not when imported. Compare real
// paths: node resolves symlinks in the module URL, argv[1] keeps them.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
