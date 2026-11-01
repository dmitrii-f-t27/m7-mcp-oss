> Modified by Dmitrii Fedorov, 2026: changed from the original M7 MCP (see NOTICE).

# Contributing to M7 MCP

This repository is an independent derivative of M7 MCP (see [README.md](README.md)). Contributions are accepted; no review schedule is promised. Before investing significant effort, open an issue describing the change.

## Prerequisites

- Node.js 22 or newer
- npm
- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in the environment. The server checks both at startup. Placeholder values are sufficient unless you work on Hive.

## Setup

```bash
git clone <your-fork>
cd m7-mcp-oss
npm install
cp .env.example .env        # add keys or placeholders
npm run build               # tsc → dist/
npm test                    # scripts/run-tests.sh
```

Tests import from `dist/`, so build first. A test that writes state binds its own temporary project (`bindProject` / `makeProject` in `tests/helpers/deepScanHarness.mjs`); `npm test` fails if a run leaves files in the repository.

`npm test` points the model SDKs at a closed local port, so a test run does not reach the real APIs.

`npm test` also runs the safety engine tests compiled to `dist/core/safety/__tests__/`.

Test servers read the install-directory .env, so keep M7_TELEMETRY_ENDPOINT, M7_MESH_RELAY and M7_ALLOW_REMOTE_CLASSIFICATION out of it while running tests.

To run the server manually:

```bash
M7_DEBUG=true node dist/index.js
```

Logs go to stderr; stdout is the MCP channel and must stay clean.

## Development process

Changes to this repository follow the methodology the server implements. For a non-trivial change that means a cycle with the phases INTAKE → DISCOVERY → ARCHITECTURE → SOLUTION → IMPACT → SIMULATION → IMPLEMENTATION, each producing a short artifact. The operational guide is [M7-GUIDE.md](M7-GUIDE.md); the specification is [Methodology/IDEAL_METHODOLOGY.md](Methodology/IDEAL_METHODOLOGY.md).

If you work with the server connected to your editor, `mcp_m7_analyze_task` and `mcp_m7_cycle` drive the phases. If you do not, write the artifacts by hand in `docs/debug/<task>/` or `docs/features/<task>/` and attach them to the pull request. The minimum expected for a bug fix is a discovery note (what was read, what the root cause is, with evidence) and an impact note (what else the change can affect).

Before writing code:

1. Read [INDEX.md](INDEX.md) for the project map.
2. Read [CODING_STANDARDS.md](CODING_STANDARDS.md) for repository conventions. They are specific to this repo and override general habits.
3. Search the codebase for existing implementations before adding a function or tool; `mcp_m7_contracts check` does this when the server is running.

## Coding conventions

The authoritative list is in [CODING_STANDARDS.md](CODING_STANDARDS.md). Summary:

- TypeScript strict, ESM; imports between source files use the `.js` extension.
- One tool per module under `src/core/tools/` (or its own package directory), exporting `{ name, description, inputSchema, handler }`. Registration in `src/index.ts` is wrapped in its own `try/catch`.
- Input schemas with `zod`, declared next to the handler.
- No `console.log`. Use the logger, which writes to stderr only when `M7_DEBUG=true`.
- Optional behaviour goes behind a feature flag in `src/core/config/featureFlags.ts` with a YAML override in `config/m7-config.yaml`.
- Persistent state only under the project's `.m7/` directory through the existing managers.
- Handlers return an error payload instead of throwing across the MCP boundary.

## Tests

Tests are plain Node scripts: `tests/*.test.mjs`, run with `node --test`, no framework. `scripts/run-tests.sh` runs each file in isolation with a per-file timeout (default 120 s) and sets placeholder API keys.

A change that fixes a bug should include a test that fails before the change and passes after it. A change that adds a tool should include at least a schema validation test and a happy-path handler test.

There is no coverage threshold enforced by tooling; the review checks that the changed code paths are exercised.

## Documentation

Apache-2.0 section 4(b): after changing a file from the original project, run `node scripts/mark-modified.mjs`, then `node scripts/check-notices.mjs`.

Update the documents that describe what you changed:

| Change | Update |
|---|---|
| new or removed tool | `docs/TOOLS_REGISTRY.md`, `src/core/registry/toolsRegistry.ts`, the tool count in `README.md` |
| new module or system | `INDEX.md`, `MASTER_REFERENCE.md` |
| new convention | `CODING_STANDARDS.md` |
| user-visible behaviour | `README.md`, `CHANGELOG.md` |

Documentation style: plain prose, no emoji in headings, no marketing language, facts verifiable against the code.

## Pull requests

Before opening a PR:

- `npm run build` succeeds with no TypeScript errors.
- `npm test` passes locally.
- The diff contains only changes related to the task. Unrelated reformatting or cleanup goes in a separate PR.
- Documentation listed above is updated.

The PR description should state: what the problem is, what the root cause is (for fixes), what the change does, how it was verified, and what else it could affect. Attach or link the cycle artifacts if they exist.

Merges go to `main` of this fork as fast-forwards.

## Reporting issues

Include: the version (`package.json` or `CHANGELOG.md` entry), Node version, operating system, the MCP client and its version, the exact tool call and its response, and the relevant portion of the stderr log with `M7_DEBUG=true`. For a suspected bug in the cycle orchestrator, attach the contents of `.m7/cycles/<task-id>.json` if present.

Security issues: use GitHub's private vulnerability reporting for this repository instead of a public issue.

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
