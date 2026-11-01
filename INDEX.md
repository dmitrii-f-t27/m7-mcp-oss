> Modified by Dmitrii Fedorov, 2026: changed from the original M7 MCP (see NOTICE).

# M7 MCP — Index

> Project navigation map. Read before any task.
> Details: MASTER_REFERENCE.md | Conventions: CODING_STANDARDS.md

## What is this

Independent derivative of M7 MCP by DukeDeSouth; see README.md and NOTICE.

M7 MCP Server — an MCP server that makes an AI coding agent work through a
fixed 7-phase cycle (discovery → architecture → solution → impact → simulation
→ implementation → report) with reflection gates between phases, persistent
project memory, and a set of supporting analysis tools.

**Stack:** TypeScript (ESM), Node 22, `@modelcontextprotocol/sdk`, stdio transport
**Entry point:** `src/index.ts` → `dist/index.js`

## Project Structure

```
m7-mcp-oss/
├── src/
│   ├── index.ts              ← MCP server, registers every tool in isolated try/catch
│   ├── core/
│   │   ├── orchestrator/     ← 7-phase cycle, reflection gates, carry-forward, rule reinjection
│   │   ├── tools/            ← tool handlers (analyze_task, memory, session, cycle, ...)
│   │   ├── config/           ← feature flags loaded from config/m7-config.yaml
│   │   ├── router.ts         ← task routing (simple / standard / full cycle)
│   │   ├── safety/           ← deterministic intent/safety rules
│   │   ├── task-graph/, task-transfer/, scope/, templates/ ...
│   ├── memory/               ← tiered memory, fog of war, epistemic status, ChromaDB (optional)
│   ├── hive/                 ← multi-agent coordinator (OpenAI / Anthropic clients)
│   ├── tsi/                  ← Tech Safety Intelligence: YAML pattern packs in src/tsi/patterns
│   ├── telemetry/            ← local telemetry; upload only when M7_TELEMETRY_ENDPOINT is set
│   ├── arch-advisor/, knowledge-graph/, error-database/, style-guardian/, visualizer/, mesh/ ...
│   └── rules/                ← loader and facades for the t27 rules (wasm.ts, marshal.ts, pathRules.ts, netRules.ts, policyRules.ts, meshRules.ts)
├── specs/                    ← t27 rule specs, generated C headers, MOVED.tsv, MANIFEST.sha256; specs/generate.sh builds the wasm (needs T27C, ZIG, CC; the build and tests do not)
├── wasm/m7_rules.wasm        ← the rules compiled from specs/, loaded by src/rules/wasm.ts
├── tests/                    ← node *.test.mjs (run: npm test); deepScan* = KNOWN_ISSUES acceptance (incl. no `require()` in src/), E2E, traceability
├── templates/                ← phase artifact templates
├── workflows/                ← workflow definitions
├── Methodology/              ← spec (IDEAL_METHODOLOGY), agent rules, index; archive/ = 2025 drafts
├── config/m7-config.yaml     ← feature flags and cycle settings
├── docs/                     ← guides (TOOLS_REGISTRY.md = tool list, HIVE_USER_GUIDE.md, M7_WHY_FULL_CYCLE.md)
├── M7-GUIDE.md               ← operational guide for the agent (read at chat start)
├── scripts/run-tests.sh      ← test runner with per-file timeout, fails if tests write into the repo
├── scripts/measure-t27-share.mjs ← share of logic points moved to t27; make-oracle.mjs and check-rules-manifest.mjs sit next to it
└── scripts/deep-scan-mutants.mjs ← npm run test:mutants: reverts each KNOWN_ISSUES fix in dist/, expects its test to fail
```

## Key Systems

| System | Where | Notes |
|---|---|---|
| Cycle orchestrator | `src/core/orchestrator/cycleOrchestrator.ts` | phases, gates, gate-ID nonce, grounding check; artifacts in `m7-cycles/<slug>-<id suffix>/` |
| Memory | `src/memory/` | L0/L1 RAM (bounded), L2–L4 and fog on disk (unbounded), one write queue per `MemorySystem` |
| Contract registry | `src/core/tools/critical/contracts.ts` | `mcp_m7_contracts`, stored in `PROJECT_SCHEMA.yaml` `api_contracts` |
| Task analysis | `src/core/tools/analyzeTask.ts` | routing + session creation + scope alerts |
| Hive | `src/hive/` | needs `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` |
| Feature flags | `src/core/config/featureFlags.ts` | defaults + `config/m7-config.yaml` overrides |
| Project path | `src/core/utils/projectPath.ts` | `getProjectPath()`: explicit > MCP roots > `CURSOR_WORKSPACE` > `AGENT_TRANSCRIPTS` > `M7_PROJECT_PATH` > Cursor activity scan (only if cwd is home or the install directory) > cwd |
| Cross-session learning | `src/cross-session/` | one instance per project, `<project>/.m7/cross-session/` |
| Shutdown flush | `src/core/shutdown/flushOnExit.ts` | debounced stores register a contributor |
| Package version | `src/core/utils/packageVersion.ts` | `PACKAGE_VERSION` for `serverInfo`, `m7://status`, telemetry |
| t27 rules | `specs/*.t27`, `wasm/m7_rules.wasm`, `src/rules/` | path, network, write-policy and peer-text rules; fail closed; `docs/T27_BOUNDARY.md` says what moved and what did not |

## Known Issues

Defect list and roadmap: `KNOWN_ISSUES.md` (its "Review findings" table maps the October 2026 review to items), plans in `docs/FIX_PLAN.md`. What is stored and for how long: README.


- Server requires `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` at startup (see README).
- `src/tsi/core/yamlLoader.ts` resolves pattern files from `src/tsi/patterns` even when running from `dist/`; works from a git clone, not from a dist-only install.
- Tests that write state bind a temp project (`bindProject` in `tests/helpers/deepScanHarness.mjs`); `scripts/run-tests.sh` pins `CURSOR_WORKSPACE` to the repo root and fails on any file written into the repo.
