#!/usr/bin/env node
// Modified by Dmitrii Fedorov, 2026: changed from the original M7 MCP (see NOTICE).
/**
 * Checks that the deep scan suites catch each fix being reverted.
 *
 * For every mutant: run the named test against the current build (must pass),
 * put the old behavior back into one dist/ file, run the test again (must fail),
 * restore the file. Exit code 1 if a mutant survives, a pattern no longer
 * matches the build, a baseline run fails, or a mutant was skipped.
 *
 * Two kinds of mutant:
 * - A dist mutant (the default) patches one file of dist/ in place and puts it back.
 * - A spec mutant (kind 'spec', ids starting with "SPEC ") breaks one rule of the t27 rules. It patches a copy
 *   of a generated header (specs/generated/<spec>.h), rebuilds the wasm from that copy with $ZIG, and runs the
 *   named test against a copy of the tree: dist/, tests/, specs/, src/ and scripts/ are copied into a temporary
 *   folder, the copy of dist/ gets the SHA-256 of the mutated wasm in rules/generated/constants.js, and the
 *   mutated wasm goes to wasm/ of the copy. The tracked wasm, the generated headers and dist/ are never written,
 *   so an interrupted run leaves the tree as it was; the temporary folder is removed on exit and on SIGINT or SIGTERM.
 *   Before the named test runs, the mutated wasm must pass the loader of the copy (assertRulesLoaded: hash,
 *   no imports, known answers). A wasm the loader rejects is reported as LOADER, never as KILLED: a mutant must be
 *   killed by its named test through the facade, not by the loader. A mutation that changes nothing is NOOP.
 *   Without ZIG a spec mutant prints SKIPPED and is not counted as killed (the exit code is 1).
 *
 * Run: npm run build && npm run test:mutants
 *      ONLY=GRAPH npm run test:mutants   (mutants whose id starts with ONLY)
 *      ZIG=<zig> ONLY=SPEC npm run test:mutants   (the spec mutants only)
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const ACCEPTANCE = 'tests/deepScanAcceptance.test.mjs';
const E2E = 'tests/deepScanE2E.test.mjs';

const MUTANTS = [
  {
    id: 'CYC-1', file: 'dist/core/orchestrator/cycleOrchestrator.js',
    find: "return valid.includes(str) ? str : null;", replace: "return valid.includes(str) ? str : 'continue';",
    test: ACCEPTANCE, name: 'unparseable or unknown reflection is rejected',
  },
  {
    id: 'CYC-2', file: 'dist/core/orchestrator/cycleOrchestrator.js',
    find: 'if (la.sha256 !== this.hashSubmitContent(content)) {',
    replace: 'if (la.phase !== state.currentPhase || la.kind !== kind) { return null; }\n        if (la.sha256 !== this.hashSubmitContent(content)) {',
    test: ACCEPTANCE, name: 'tool retry of an accepted reflection',
  },
  {
    id: 'CYC-3', file: 'dist/core/orchestrator/cycleOrchestrator.js',
    find: "if (s === 'completed' || s === 'aborted') {\n            return { success: false, error: `Cycle is ${s}` };",
    replace: "if (false) {\n            return { success: false, error: `Cycle is ${s}` };",
    test: ACCEPTANCE, name: 'completed and aborted cycles are terminal',
  },
  {
    id: 'CYC-9', file: 'dist/core/orchestrator/cycleOrchestrator.js',
    find: "if (status === 'active')\n            return true;", replace: "if (status === 'active')\n            return false;",
    test: ACCEPTANCE, name: 'cleanup only archives terminal cycles',
  },
  {
    id: 'CYC-10 (folder from the id)', file: 'dist/core/orchestrator/cycleOrchestrator.js',
    find: 'const taskSlug = `${slug}-${suffix}`;', replace: 'const taskSlug = slug;',
    test: ACCEPTANCE, name: 'two cycles with one description → two folders',
  },
  {
    id: 'CYC-10 (exclusive folder)', file: 'dist/core/orchestrator/cycleOrchestrator.js',
    find: 'await fs.mkdir(artifactsDir);', replace: 'await fs.mkdir(artifactsDir, { recursive: true });',
    test: ACCEPTANCE, name: 'a taken id or folder is never reused',
  },
  {
    id: 'CYC-10 (through the server)', file: 'dist/core/orchestrator/cycleOrchestrator.js',
    find: 'const taskSlug = `${slug}-${suffix}`;', replace: 'const taskSlug = slug;',
    test: E2E, name: 'each gets its own artifact folder',
  },
  {
    id: 'STATE-5 (load awaited)', file: 'dist/core/tools/critical/contracts.js',
    find: '        await registry.ready();\n        switch (request.action) {', replace: '        switch (request.action) {',
    test: ACCEPTANCE, name: 'function, endpoint, method, class',
  },
  {
    id: 'STATE-5 (stable ids)', file: 'dist/core/tools/critical/contracts.js',
    find: 'id: entry.id || this.generateId(),', replace: 'id: this.generateId(),',
    test: ACCEPTANCE, name: 'function, endpoint, method, class',
  },
  {
    id: 'STATE-5 (failure reported)', file: 'dist/core/tools/critical/contracts.js',
    find: "category: 'runtime'\n            });\n            throw error;", replace: "category: 'runtime'\n            });",
    test: ACCEPTANCE, name: 'no PROJECT_SCHEMA.yaml → register fails',
  },
  {
    id: 'STATE-5 (through the server)', file: 'dist/core/tools/critical/contracts.js',
    find: 'for (const [section, type] of CONTRACT_SECTIONS) {', replace: 'for (const [section, type] of CONTRACT_SECTIONS.slice(0, 1)) {',
    test: E2E, name: 'three kinds registered',
  },
  {
    id: 'STATE-3 (drain on exit)', file: 'dist/index.js',
    find: 'registerShutdownContributor(() => this.orchestrator.flushPersist());', replace: '',
    test: E2E, name: 'session is on disk and visible after restart',
  },
  {
    id: 'STATE-3 (pinned file)', file: 'dist/core/orchestrator/taskOrchestrator.js',
    find: 'return this.sessionsFilePath;', replace: "return path.join(getProjectPath(), '.m7', 'orchestrator-sessions.json');",
    test: ACCEPTANCE, name: 'keeps writing to A',
  },
  {
    id: 'STATE-3 (load race)', file: 'dist/core/tools/unified/sessionTool.js',
    find: 'await orchestrator.ready();\n', replace: '',
    test: ACCEPTANCE, name: 'no race with the async load',
  },
  {
    id: 'STATE-4 (cross-session store)', file: 'dist/cross-session/knowledge-accumulator.js',
    find: "this.basePath = path.join(projectPath, '.m7', 'cross-session');",
    replace: "this.basePath = path.join(process.cwd(), '.m7', 'cross-session');",
    test: ACCEPTANCE, name: 'stored under the project, nothing under cwd',
  },
  {
    id: 'STATE-4 (server cwd ≠ project)', file: 'dist/cross-session/knowledge-accumulator.js',
    find: "this.basePath = path.join(projectPath, '.m7', 'cross-session');",
    replace: "this.basePath = path.join(process.cwd(), '.m7', 'cross-session');",
    test: E2E, name: 'nothing under cwd',
  },
  {
    id: 'STATE-4 (instance per project)', file: 'dist/cross-session/index.js',
    find: 'let instance = instances.get(projectPath);', replace: 'let instance = instances.values().next().value;',
    test: ACCEPTANCE, name: 'one instance per project',
  },
  {
    id: 'STATE-4 (git default dir)', file: 'dist/telemetry/gitCapture.js',
    find: 'cwd: cwd || getProjectPath(),', replace: 'cwd: cwd || process.cwd(),',
    test: ACCEPTANCE, name: 'git capture defaults to the project',
  },
  {
    id: 'MEM-2', file: 'dist/memory/auto/unified-memory-core.js',
    find: 'confidence: data.confidence ?? 0.5,', replace: 'confidence: data.confidence || 0.5,',
    test: ACCEPTANCE, name: 'confidence 0 survives a round trip',
  },
  {
    id: 'MEM-5 (long-term level)', file: 'dist/memory/memorySystem.js',
    find: 'longterm: new Map(),', replace: 'longterm: new BoundedMap(2000),',
    test: ACCEPTANCE, name: 'review trace: first record, then 2000 more',
  },
  {
    id: 'MEM-5 (fog of war)', file: 'dist/memory/memorySystem.js',
    find: 'this.fogOfWar = new Map();', replace: 'this.fogOfWar = new BoundedMap(500);',
    test: ACCEPTANCE, name: 'fog of war: a 600-entry file',
  },
  {
    id: 'MEM-5 (tombstones)', file: 'dist/memory/auto/unified-memory-core.js',
    find: 'const deletedIds = new Set();',
    replace: "const deletedIds = new (await import('../../core/utils/boundedMap.js')).BoundedSet(5000);",
    test: ACCEPTANCE, name: 'tombstones: 5001 on disk',
  },
  {
    id: 'MEM-6', file: 'dist/schema/schemaSystem.js',
    find: '            return this.schema;\n        }',
    replace: "            await (await (await import('../memory/auto/unified-memory-core.js')).getMemoryCore()).store(JSON.stringify(this.schema), { level: 'L2', source: 'code_analysis', contextKeys: ['project', 'schema'], confidence: 1.0 }).catch(() => {});\n            return this.schema;\n        }",
    test: ACCEPTANCE, name: 'three loadSchema() calls',
  },
  {
    id: 'MEM-7 (one write queue)', file: 'dist/memory/memorySystem.js',
    find: 'const run = this.writeChain.then(task);', replace: 'const run = Promise.resolve().then(task);',
    test: ACCEPTANCE, name: '500 stores while the first file write is held',
  },
  {
    id: 'MEM-7 (retired core drained)', file: 'dist/memory/auto/unified-memory-core.js',
    find: 'await Promise.all([memoryCore?.shutdown(), ...retiringCores]);', replace: 'await memoryCore?.shutdown();',
    test: ACCEPTANCE, name: 'a write in project A right before a switch',
  },
  {
    id: 'GRAPH-1', file: 'dist/core/task-graph/taskGraphManager.js',
    find: 'if (seenAt !== undefined && depth <= seenAt)', replace: 'if (seenAt !== undefined)',
    test: ACCEPTANCE, name: 'depth-limited traversal includes every node',
  },
  {
    id: 'GRAPH-2', file: 'dist/core/task-graph/taskGraphManager.js',
    find: 'if (this.graph.nodes[options.id]) {\n            throw new Error(`Task id already exists',
    replace: 'if (false) {\n            throw new Error(`Task id already exists',
    test: ACCEPTANCE, name: 'createTask refuses to overwrite an existing id',
  },
  {
    id: 'GRAPH-3', file: 'dist/core/task-transfer/transferManager.js',
    find: 'await this.graphManager.restoreTask(fromSnapshot);',
    replace: 'await this.graphManager.updateTaskStatus(fromTaskId, fromSnapshot.status);',
    test: ACCEPTANCE, name: 'graph JSON before equals graph JSON after',
  },
  {
    id: 'GATE-2', file: 'dist/core/orchestrator/groundingGate.js',
    find: "if (step.reversibility === 'irreversible'\n            && step.premise_ids.length === 0) {", replace: 'if (false) {',
    test: ACCEPTANCE, name: 'exactly one strong warning',
  },
  {
    id: 'HYG-1 (unicode slug)', file: 'dist/core/orchestrator/cycleOrchestrator.js',
    find: ".replace(/[^\\p{L}\\p{M}\\p{N}\\s-]/gu, '')", replace: ".replace(/[^a-zа-яё0-9\\s-]/gi, '')",
    test: ACCEPTANCE, name: 'emoji and punctuation-only',
  },
  {
    id: 'HYG-1 (hash fallback)', file: 'dist/core/orchestrator/cycleOrchestrator.js',
    find: "return slug || createHash('sha1').update(description).digest('hex').slice(0, 8);", replace: 'return slug;',
    test: ACCEPTANCE, name: 'emoji and punctuation-only',
  },
  {
    id: 'HYG-2', file: 'dist/hive/cache/taskResultCache.js',
    find: ".replace(/[^\\p{L}\\p{N}\\s]/gu, ' ')", replace: ".replace(/[^\\w\\s]/g, ' ')",
    test: ACCEPTANCE, name: 'hive cache keys keep non-Latin text',
  },
  {
    id: 'HYG-3', file: 'dist/hive/context/fileSearcher.js',
    find: "'-i', '-e', keyword]", replace: "'-i', keyword]",
    test: ACCEPTANCE, name: 'looks like a grep option',
  },
  {
    id: 'HYG-4', file: 'dist/index.js',
    find: "log('  OPENAI_API_KEY: set');", replace: 'log(`  OPENAI_API_KEY: set (${openaiKey.substring(0, 15)}...)`);',
    test: E2E, name: '8-character piece',
  },
  {
    id: 'HYG-9 (hint)', file: 'dist/core/health/healthCheck.js',
    find: 'action: `optional: start ChromaDB at ${chromaUrl} or set CHROMA_URL; memory uses local JSON until then`,',
    replace: "action: 'docker compose up -d',",
    test: ACCEPTANCE, name: 'the hint names CHROMA_URL and the local fallback',
  },
  {
    id: 'HYG-9 (no docker)', file: 'dist/core/health/healthCheck.js',
    find: '    const components = [',
    replace: "    try { (await import('node:child_process')).execSync('docker compose up -d', { cwd: process.cwd(), stdio: 'ignore', timeout: 5000 }); } catch {}\n    const components = [",
    test: E2E, name: 'docker on PATH: never invoked',
  },
  {
    id: 'HYG-10 (git fields independent)', file: 'dist/core/tools/projectIndex/projectScanner.js',
    find: '.then(({ stdout }) => stdout.trim() || undefined, () => undefined);',
    replace: '.then(({ stdout }) => stdout.trim() || undefined);',
    test: ACCEPTANCE, name: 'project scan reads branch and last commit',
  },
  {
    id: 'HYG-10 (no cascade invalidation)', file: 'dist/memory/auto/unified-memory-core.js',
    find: '    getDependencyGraph(recordId) {',
    replace: '    async invalidateDependents(recordId) { return []; }\n    getDependencyGraph(recordId) {',
    test: ACCEPTANCE, name: 'no RAM-only cascade invalidation',
  },
  {
    id: 'HYG-8', file: 'dist/index.js',
    find: "name: '@m7/mcp-server',\n            version: PACKAGE_VERSION,", replace: "name: '@m7/mcp-server',\n            version: '2.0.0',",
    test: E2E, name: 'serverInfo and m7://status report the package version',
  },
  {
    id: 'HYG-11 (tsi)', file: 'dist/tsi/index.js',
    find: 'return new TSISystemClass(config);',
    replace: "const { TSISystem } = require('./tsiSystem.js');\n    return new TSISystem(config);",
    test: ACCEPTANCE, name: 'createTSISystem() returns a TSI system',
  },
  {
    id: 'HYG-11 (mesh presence)', file: 'dist/mesh/MeshManager.js',
    find: 'hostname: hostname(),', replace: "hostname: require('os').hostname(),",
    test: ACCEPTANCE, name: 'joining the mesh writes the presence file',
  },
  {
    id: 'SEC-32 (task meta)', file: 'dist/core/task-graph/taskGraphManager.js',
    find: 'await writeRegularFileIfAbsent(this.projectPath, metaRel, JSON.stringify(meta, null, 2));',
    replace: "await fs.writeFile(path.join(this.projectPath, metaRel), JSON.stringify(meta, null, 2), 'utf-8');",
    test: 'tests/sec-write-paths.test.mjs',
    name: 'analyze_task leaves the outside file alone when the task folder holds a TASK_META.json link',
  },
  {
    id: 'SEC-33 (authority)', file: 'dist/core/safety/trapCatalog.js',
    find: 'LIFTS_CONTENT_LIMITS.test(a.normalized)', replace: 'false',
    test: 'dist/core/safety/__tests__/stress.test.js', name: 'Sudo/admin mode claim',
  },
  {
    id: 'SEC-33 (fail closed)', file: 'dist/core/safety/pipeline.js',
    find: "return this.failClosed(start, 'input_trap');", replace: "return this.passThrough(start, 'input_trap_error');",
    test: 'tests/safetyVerdicts.test.mjs', name: 'a scan error answers block',
  },
  // Spec mutants. Each patch is C in a generated header and must be one place only (STALE otherwise). Each one
  // is chosen to pass the known-answer calls of the loader (src/rules/wasm.ts, KNOWN_ANSWERS), so the named test
  // is what kills it, through the facade and the swapped wasm.
  {
    // Control paths are looked for before secrets. KNOWN_ANSWERS has ".git" (control only) and "a.key" (secret only).
    id: 'SPEC pr_pull_verdict', kind: 'spec', spec: 'path_rules',
    find: `    if (pr_any_segment(joined, len, false)) {
        return PR_VERDICT_SECRET;
    }
    if (pr_any_segment(joined, len, true)) {
        return PR_VERDICT_CONTROL;
    }
    return PR_VERDICT_OK;
}

bool pr_is_inside(`,
    replace: `    if (pr_any_segment(joined, len, true)) {
        return PR_VERDICT_CONTROL;
    }
    if (pr_any_segment(joined, len, false)) {
        return PR_VERDICT_SECRET;
    }
    return PR_VERDICT_OK;
}

bool pr_is_inside(`,
    test: 'tests/rulesPath.test.mjs',
    name: 'equal on 200000 seeded paths with the edge shapes',
  },
  {
    // The Windows reading no longer ignores ASCII case. KNOWN_ANSWERS calls pr_is_inside with win = 0 only.
    id: 'SPEC pr_is_inside', kind: 'spec', spec: 'path_rules',
    find: 'if ((by_fold_ascii(x) == by_fold_ascii(y))) {',
    replace: 'if ((x == y)) {',
    test: 'tests/rulesPath.test.mjs',
    name: 'equal for every pair over a small alphabet, both flags',
  },
  {
    // The scheme of an Origin must be lower case. KNOWN_ANSWERS has only lower-case schemes for Origin.
    id: 'SPEC nr_origin_allowed', kind: 'spec', spec: 'net_rules',
    find: 'if ((by_fold_ascii(text[k]) != NR_HTTP_PREFIX[k])) {',
    replace: 'if ((text[k] != NR_HTTP_PREFIX[k])) {',
    test: 'tests/rulesNet.test.mjs',
    name: 'accept exactly the loopback names with the right port, in any letter case, and refuse the rest',
  },
  {
    // U+200F (right-to-left mark) is no longer a control. KNOWN_ANSWERS has U+200B only.
    id: 'SPEC mr_is_control', kind: 'spec', spec: 'mesh_rules',
    find: 'if (((code >= 8203) && (code <= 8207))) {',
    replace: 'if (((code >= 8203) && (code <= 8206))) {',
    test: 'tests/rulesMesh.test.mjs',
    name: 'equal for every code point from 0 to 0x10FFFF',
  },
  {
    // A file M7 manages is skipped, not updated. KNOWN_ANSWERS has the absent and the foreign state only.
    id: 'SPEC po_write_action', kind: 'spec', spec: 'policy_rules',
    find: 'return PO_WRITE_UPDATE;',
    replace: 'return PO_WRITE_SKIP;',
    test: 'tests/rulesPolicy.test.mjs',
    name: 'managedWriteAction and managedSyncAction equal the old ones for all three states',
  },
  {
    // M7_PROJECT_PATH wins before the Roots step has finished. KNOWN_ANSWERS has the Cursor env and none.
    id: 'SPEC pr_env_source', kind: 'spec', spec: 'path_rules',
    find: `        if (roots_complete) {
            return PR_SRC_M7_PROJECT_PATH;
        }
        return PR_SRC_PROCESS_CWD;`,
    replace: '        return PR_SRC_M7_PROJECT_PATH;',
    test: 'tests/rulesPath.test.mjs',
    name: 'selectProjectSource equals the old one for all 32 combinations of the five facts',
  },
];

const env = {
  ...process.env,
  CURSOR_WORKSPACE: process.env.CURSOR_WORKSPACE ?? ROOT,
  OPENAI_API_KEY: 'sk-test-placeholder',
  ANTHROPIC_API_KEY: 'sk-ant-test-placeholder',
  OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
};

// A mutant may write wherever the old code wrote (e.g. process.cwd()); keep that out of the repo.
// `root` is the tree the test file is taken from: the repository, or the copy of a spec mutant.
async function runTest(test, name, root = ROOT) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cwd = mkdtempSync(path.join(tmpdir(), 'm7-mutant-cwd-'));
  const out = await execFileAsync(
    process.execPath,
    ['--test', '--test-force-exit', `--test-name-pattern=${escaped}`, path.join(root, test)],
    { cwd, env, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  ).then(r => r.stdout + r.stderr, err => (err.stdout ?? '') + (err.stderr ?? ''))
    .finally(() => rmSync(cwd, { recursive: true, force: true }));
  const count = key => Number(new RegExp(`^ℹ ${key} (\\d+)`, 'm').exec(out)?.[1] ?? 0);
  const reason = out.split('\n').find(l => /AssertionError|Error:/.test(l))?.trim() ?? '';
  // The failing tests, as the spec reporter prints them; the test itself is listed before its suites.
  const failed = [...new Set([...out.matchAll(/^\s*✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/gm)].map(m => m[1]))];
  return { pass: count('pass'), fail: count('fail'), reason, failed };
}

const originals = new Map();
const restoreAll = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
  originals.clear();
};

// ---------------------------------------------------------------------------
// Spec mutants: a copy of the tree with a rebuilt wasm. Nothing tracked is written.
// ---------------------------------------------------------------------------

const workFolders = new Set();
const removeWorkFolders = () => {
  for (const dir of workFolders) rmSync(dir, { recursive: true, force: true });
  workFolders.clear();
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreAll();
    removeWorkFolders();
    process.exit(130);
  });
}
process.on('exit', removeWorkFolders);

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const SHA_CONSTANT = /(export const WASM_SHA256 = ")([0-9a-f]{64})(";)/;
let zigCache = null;
let rebuildChecked = null;

/** The names listed in specs/exports.txt (a # starts a comment). */
function exportNames() {
  return readFileSync(path.join(ROOT, 'specs', 'exports.txt'), 'utf8')
    .split('\n').flatMap(line => line.replace(/#.*/, '').split(/\s+/)).filter(Boolean);
}

/** Build `wasm/m7_rules.wasm` of the copy `ws` from its specs/generated and specs/wasm, as specs/generate.sh does. */
async function buildWasm(ws) {
  zigCache ??= process.env.ZIG_GLOBAL_CACHE_DIR ?? (() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'm7-mutant-zig-'));
    workFolders.add(dir);
    return dir;
  })();
  const args = [
    'cc', '--target=wasm32-wasi', '-mexec-model=reactor', '-O2', '-DNDEBUG', '-fwrapv', '-ffp-contract=off', '-std=c11',
    '-Wno-parentheses-equality', '-s', '-I', 'specs/generated', '-Wl,--no-entry', '-Wl,--gc-sections',
    ...exportNames().map(n => `-Wl,--export=${n}`), 'specs/wasm/m7_rules_wasm.c', '-o', 'wasm/m7_rules.wasm',
  ];
  mkdirSync(path.join(ws, 'wasm'), { recursive: true });
  await execFileAsync(process.env.ZIG, args, {
    cwd: ws,
    env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: zigCache, ZIG_LOCAL_CACHE_DIR: path.join(ws, '.zig-local') },
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** A copy of what the tests need. node_modules is linked; dist/ is a real copy, because the loader follows links. */
function makeWorkFolder() {
  const ws = mkdtempSync(path.join(tmpdir(), 'm7-spec-mutant-'));
  workFolders.add(ws);
  for (const entry of ['dist', 'tests', 'specs', 'src', 'scripts', 'wasm', 'package.json']) {
    cpSync(path.join(ROOT, entry), path.join(ws, entry), { recursive: true });
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(ws, 'node_modules'));
  return ws;
}

/** null when the loader of the copy accepts its wasm, otherwise the first line of the error. */
async function loaderVerdict(ws) {
  const url = pathToFileURL(path.join(ws, 'dist', 'rules', 'wasm.js')).href;
  const cwd = mkdtempSync(path.join(tmpdir(), 'm7-mutant-cwd-'));
  return execFileAsync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(url)}).then(m => m.assertRulesLoaded())`],
    { cwd, env, timeout: 60_000 })
    .then(() => null, err => (err.stderr ?? err.message).split('\n').find(l => l.startsWith('RulesUnavailableError:'))?.trim() ?? 'the load failed')
    .finally(() => rmSync(cwd, { recursive: true, force: true }));
}

/** Runs one spec mutant. Returns { verdict: 'killed' | 'bad' | 'skipped', line }. */
async function runSpecMutant(m) {
  if (!process.env.ZIG) return { verdict: 'skipped', line: `SKIPPED   ${m.id}: ZIG is not set; the wasm cannot be rebuilt, so nothing was tested` };
  const headerRel = path.join('specs', 'generated', `${m.spec}.h`);
  const header = readFileSync(path.join(ROOT, headerRel), 'utf8');
  const hits = header.split(m.find).length - 1;
  if (hits !== 1) return { verdict: 'bad', line: `STALE     ${m.id}: the pattern is in ${headerRel} ${hits} times, it must be there once` };
  if (!existsSync(path.join(ROOT, 'node_modules'))) return { verdict: 'bad', line: `STALE     ${m.id}: no node_modules in the repository` };
  const trackedSha = sha256(path.join(ROOT, 'wasm', 'm7_rules.wasm'));
  const ws = makeWorkFolder();
  try {
    const base = await runTest(m.test, m.name, ws);
    if (base.pass === 0 || base.fail > 0) {
      return { verdict: 'bad', line: `BASELINE  ${m.id}: pass=${base.pass} fail=${base.fail} without the mutation` };
    }
    if (rebuildChecked === null) {
      await buildWasm(ws);
      rebuildChecked = sha256(path.join(ws, 'wasm', 'm7_rules.wasm')) === trackedSha;
      cpSync(path.join(ROOT, 'wasm', 'm7_rules.wasm'), path.join(ws, 'wasm', 'm7_rules.wasm'));
    }
    if (!rebuildChecked) {
      return { verdict: 'bad', line: `BASELINE  ${m.id}: $ZIG does not rebuild the tracked wasm from the unchanged headers; the compiler is not the pinned one` };
    }
    writeFileSync(path.join(ws, headerRel), header.replace(m.find, () => m.replace));
    await buildWasm(ws);
    const wasmFile = path.join(ws, 'wasm', 'm7_rules.wasm');
    const mutantSha = sha256(wasmFile);
    if (mutantSha === trackedSha) return { verdict: 'bad', line: `NOOP      ${m.id}: the mutated header builds the same wasm` };
    const constants = path.join(ws, 'dist', 'rules', 'generated', 'constants.js');
    const constantsText = readFileSync(constants, 'utf8');
    if (!SHA_CONSTANT.test(constantsText)) return { verdict: 'bad', line: `STALE     ${m.id}: no WASM_SHA256 in dist/rules/generated/constants.js` };
    writeFileSync(constants, constantsText.replace(SHA_CONSTANT, (_all, a, _old, c) => `${a}${mutantSha}${c}`));
    const rejected = await loaderVerdict(ws);
    if (rejected !== null) return { verdict: 'bad', line: `LOADER    ${m.id}: the loader rejects the mutated wasm, so the named test would not be what kills it (${rejected.slice(0, 160)})` };
    const mut = await runTest(m.test, m.name, ws);
    if (mut.fail > 0) {
      return { verdict: 'killed', line: `KILLED    ${m.id}  [${m.test} > ${mut.failed[0] ?? '?'}]  (wasm ${mutantSha.slice(0, 12)}, loader accepts it; ${mut.reason.slice(0, 100)})` };
    }
    return { verdict: 'bad', line: `SURVIVED  ${m.id}: "${m.name}" still passes with the old behavior` };
  } finally {
    rmSync(ws, { recursive: true, force: true });
    workFolders.delete(ws);
  }
}

const selected = MUTANTS.filter(m => !process.env.ONLY || m.id.startsWith(process.env.ONLY));
let bad = 0;
let killed = 0;
let skipped = 0;
for (const m of selected) {
  if (m.kind === 'spec') {
    const r = await runSpecMutant(m);
    console.log(r.line);
    if (r.verdict === 'killed') killed++;
    else if (r.verdict === 'skipped') skipped++;
    else bad++;
    continue;
  }
  const file = path.join(ROOT, m.file);
  const source = readFileSync(file, 'utf8');
  if (!source.includes(m.find)) {
    console.log(`STALE     ${m.id}: pattern not found in ${m.file} (rebuild, or update the mutant)`);
    bad++;
    continue;
  }
  const base = await runTest(m.test, m.name);
  if (base.pass === 0 || base.fail > 0) {
    console.log(`BASELINE  ${m.id}: pass=${base.pass} fail=${base.fail} without the mutation`);
    bad++;
    continue;
  }
  originals.set(file, source);
  writeFileSync(file, source.replace(m.find, m.replace));
  try {
    const mut = await runTest(m.test, m.name);
    if (mut.fail > 0) {
      console.log(`KILLED    ${m.id}  [${m.test} > ${mut.failed[0] ?? '?'}]  (${mut.reason.slice(0, 100)})`);
      killed++;
    } else {
      console.log(`SURVIVED  ${m.id}: "${m.name}" still passes with the old behavior`);
      bad++;
    }
  } finally {
    restoreAll();
  }
}

console.log(`\n${killed}/${selected.length} mutants killed`);
if (skipped > 0) console.log(`${skipped} SKIPPED: a spec mutant needs ZIG (the path of the pinned zig) to rebuild the wasm; a skip is not a pass`);
process.exit(bad || skipped || selected.length === 0 ? 1 : 0);
