> Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).

# Security

> This file describes this independent derivative, not the original project.

## What stays open

This list is built from the rows in "Status of known risks" whose status starts
with OPEN. It is not a promise that nothing else exists.

- **SEC-33 remainder (LOW):** `mcp_m7_safety_verify` is still a hint, not a
  boundary. It matches English word lists, so reworded text can pass.
- **SEC-34 (LOW):** one regular expression in the same scan is quadratic on a very
  long word, and the tool has no size limit, so such a text can hold up the server.
- **SEC-11 (LOW):** Hive has no global spend limit and no cancel.
- **SEC-13 (LOW):** the mesh relay answers every request with
  `Access-Control-Allow-Origin: *`.
- **SEC-16 (LOW, by design):** an explicit `project_path` is accepted if the
  directory exists, and it sticks for the session.
- **SEC-17 (LOW):** `logger.ts` redacts nothing. It writes only when
  `M7_DEBUG=true`.
- **SEC-23 (LOW):** `create_structure` with a `task_id` such as `../../x` stays
  inside the project but can put templates outside `docs/`.
- **SEC-24 (LOW, by design):** `push-file` can send control paths such as
  `.git/config`. Only `pull-file` refuses them.
- **SEC-25 (LOW):** mesh error text is flattened to one line but not fenced.
- **SEC-28 (LOW):** `GraphVisualizerService` keeps the knowledge graph of the
  first project after the project changes.
- **SEC-29 (LOW):** with both keys set, the server sends a model list request to
  OpenAI and a 1-token `Hi` message to Anthropic for each of five model names
  at start, using your keys. SEC-29 is unchanged in this version and has no
  switch. The server also refuses to start without both keys.
- **SEC-30 (LOW):** Hive sends up to three chunks of project memory with the
  task to OpenAI and Anthropic, and no switch turns this off.
- **SEC-19 remainder (LOW):** `style_guardian` `analyze` reads any directory the
  process can read. It writes nothing into the project.

Also open:

- **Dependencies.** `npm audit` still lists 6 entries (1 low, 3 moderate, 2 high,
  0 critical): `zod`, `openai`, `diff`, `minimatch`, `ts-morph` and
  `@ts-morph/common`. See "Dependencies: `npm audit`".
- **No run with real model keys was done.** Model behaviour and SEC-9 (whether
  Opus models reject `temperature`) are not verified live. See "What is not
  verified".

## What leaves the machine

M7 runs on your machine and keeps its state in the project directory. This
section lists what is sent to another host, and when.

### Your task text

- **Default:** `mcp_m7_analyze_task` classifies the task locally. The task text
  is not sent anywhere. The classification is a neutral default: it does not
  analyse the text, so it does not mark the task as "analysis only" or as a
  failure. It selects no scan patterns, so the pattern scan of the project
  (which the remote classifier steers) does not run.
- **Opt-in:** set `M7_ALLOW_REMOTE_CLASSIFICATION=true` (exactly `true`; the
  variable is read on every call). The task text is then sent to the OpenAI
  chat completions API (`gpt-4o-mini`) together with M7's classification prompt,
  once per `mcp_m7_analyze_task` call. If the same text is classified again in
  the same server process, the earlier answer is reused and nothing is sent.
- **If the remote call fails:** M7 falls back to a cautious default (analysis
  only, no code) and the tool still answers. A failed answer is not
  remembered. The OpenAI client retries a failed request twice, and the second
  classification inside the same `mcp_m7_analyze_task` call asks again. If the
  remote keeps failing, the text can therefore be sent up to six times in one
  call (two classifications, three attempts each).
- **Logs:** with `M7_DEBUG=true` the classifier logs the length of the text,
  never the text.

### Requests without task text

The switch above covers the task text only. With both API keys set, M7 also
makes these requests. They use your keys and carry no task text.

- **At server start:** a model list request to OpenAI, and one 1-token `Hi`
  message to Anthropic for each of five model names (model discovery, to pick
  models for Hive). There is no switch for this (SEC-29).
- **On the first `mcp_m7_analyze_task` call of a server process:** a model list
  request to OpenAI and one to Anthropic (the time and models header). The
  result is kept in memory for 24 hours.

### Other destinations you control

- **Hive** (`mcp_m7_hive_coordinator`) calls OpenAI and Anthropic with the task
  you give it. It also sends more than the task: up to three chunks of your
  project memory that match the task (300 characters each), and, when the mesh
  is active, the context of the other M7 instances (role, project path, the
  first 12 characters of the instance id, the process id and up to three
  published context texts of 150 characters each). The text from other
  instances is marked as untrusted data. The switch above does not cover Hive,
  and nothing turns off the memory chunks or the peer contexts (SEC-30).
- **Telemetry** is sent only if you set `M7_TELEMETRY_ENDPOINT`.
- **Mesh relay** traffic goes only to the host in `M7_MESH_RELAY`.
- **ChromaDB** is read at `CHROMA_URL` (default `http://localhost:8000`).

## The visualizer (`mcp_m7_visualizer`)

The visualizer starts only when you call `mcp_m7_visualizer` with
`action: "start"`. It serves the dependency graph of the project and the
current context (active file, modified files, task description).

- **Where it listens:** the HTTP server (default port 3848) and the WebSocket
  server (default port 3847) bind to `127.0.0.1` only. Other machines on the
  network cannot connect. Open `http://127.0.0.1:3848`.
- **No CORS headers.** No HTTP answer carries an `Access-Control-*` header,
  including the answer to a preflight (`OPTIONS`) request. A browser therefore
  stops a web page from another site from reading the answers.
- **Host check.** Every HTTP request must carry the Host
  `127.0.0.1:<http port>` or `localhost:<http port>`. Any other Host gets 403.
  This stops DNS rebinding, where a foreign name resolves to `127.0.0.1`.
- **Origin check.** A WebSocket upgrade that carries an Origin header must come
  from `http://127.0.0.1:<http port>` or `http://localhost:<http port>`. Any
  other Origin gets 403, so a web page from another site cannot open the
  socket. An upgrade with no Origin header is accepted: browsers always send
  one, and a program that runs as your user and is not a browser can read the
  project files without the visualizer.
- **Message size:** the WebSocket server refuses messages larger than 64 KiB.
- **There is no token or password.** Any other user account on the same
  machine can connect to `127.0.0.1` while the visualizer runs and read what it
  serves. Do not start the visualizer on a shared multi-user machine.

## The `.env` file

The server reads API keys and settings from the process environment and from
one `.env` file: the file in the M7 install directory (the parent of `dist/`).

- **No `.env` from the working directory.** The MCP client chooses the working
  directory of the server, and it can be a project folder you do not control.
  A `.env` there is not read, so it cannot supply keys or settings such as
  `M7_MESH_RELAY`, `M7_TELEMETRY_ENDPOINT`, `CHROMA_URL` or
  `M7_ALLOW_REMOTE_CLASSIFICATION`.
- **The process environment wins.** A variable that is already set (for
  example in the `env` block of your MCP client config) is not replaced by the
  file.
- **What stops working:** a `.env` in some other working directory. Move the
  keys to the `.env` in the install directory (`cp .env.example .env` in the
  repository root) or to the `env` block of your MCP client config.

## Anthropic sampling parameters (Opus models)

Hive calls to the Anthropic Messages API used to send a fixed `temperature`
(0.1 to 0.3) to every model. M7 now sends no `temperature` to a model whose
name starts with `claude-opus-`, and still sends it to every other model
(`src/hive/api/anthropicParams.ts`, used at all seven call sites).

- **Not verified:** newer Opus models are said to reject a non-default
  sampling parameter, so the old requests may have failed with a 400 error.
  This has not been checked. It needs a live call with a real key, and the
  tests in this repository make no network call. The tests prove what M7
  sends, not what the API accepts.
- **Behaviour change without a failure:** Opus 4.5 and 4.6 now run at the API
  default temperature, not 0.1 to 0.3. Answers from those models can vary more
  from run to run.
- **Other models are unchanged.** The OpenAI calls and the streaming executor
  are not touched.

## The mesh relay (`src/mesh/relay/server.ts`)

The relay is a separate program. You start it on purpose
(`node dist/mesh/relay/server.js`). The MCP server does not start it.
Workstations join it with `M7_MESH_RELAY` and `M7_MESH_SECRET`.

- **Where it listens.** The relay binds to `M7_RELAY_HOST`. The default is
  `127.0.0.1`, so only programs on the same machine can reach it. Earlier
  versions listened on every network interface.
- **A relay that other machines must reach.** Set `M7_RELAY_HOST=0.0.0.0` (all
  interfaces) or the address of one interface. This is a breaking change: after
  an update, an existing deployment is unreachable from other machines until you
  set the variable. Put TLS in front of the relay (a reverse proxy or a tunnel).
  The relay speaks plain HTTP, so the bearer token travels in clear text.
- **Token compare.** The relay hashes the presented `Authorization` header and
  the expected `Bearer <secret>` with SHA-256 and compares the two digests with
  `crypto.timingSafeEqual`. Hashing first gives both buffers the same length.
  Only the exact string is accepted. The compare time was **not measured**:
  a timing difference this small cannot be tested honestly, so
  `tests/sec-low.test.mjs` checks only that the call is in the source and in
  the build.
- **One shared secret.** Every workstation uses the same secret. The relay
  cannot tell workstations apart: the `workstation` and `author` names in a
  request are whatever the sender writes. It sets no minimum length for
  `M7_RELAY_SECRET`. Anyone who knows the secret can read and write everything
  on the relay.
- **Open, LOW (not changed here).** The relay still answers every request,
  `/health` included, with `Access-Control-Allow-Origin: *`
  (`src/mesh/relay/server.ts:89-91`). `/health` needs no token and returns the
  number of workstations and the uptime. Every other route needs the token.

## The installer (`install.sh`)

- **Keys stay in `.env`.** The installer writes the keys you type to the `.env`
  file in the install directory and sets its mode to 600 (`install.sh:181`,
  `:195`, `:228`). On Windows `chmod` does nothing, and `install.sh` needs bash.
- **`~/.cursor/mcp.json` is merged, not replaced.** The installer calls
  `scripts/merge-cursor-config.mjs` (`install.sh:276`). The script adds or
  replaces only `mcpServers.m7`. Every other server and every other top-level
  key stays. The installer still copies the file to
  `mcp.json.backup.<time>` first (`install.sh:269`).
- **No API key goes into `mcp.json`.** The `m7` entry holds `command`, `args`
  and `cwd`, plus the `env` block of an old `m7` entry when it holds other
  variables. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are dropped from that
  block and every other variable stays, so a saved `M7_PROJECT_PATH` or
  `M7_MESH_*` survives a re-install. The block is left out when nothing is left
  in it (`scripts/merge-cursor-config.mjs:39`, `:45-49`, `:55-63`). Other secrets you saved there,
  such as `M7_MESH_SECRET`, stay in `mcp.json` as you saved them. The server
  reads its keys from the `.env` file (see the `.env` section above).
- **A file the script cannot merge into is left alone.** That means a file that
  is not valid JSON (an empty file too), whose top level is not an object, or
  whose `mcpServers` is not an object. The script writes nothing, prints the
  reason to stderr and exits with code 2. The installer then reports that the
  Cursor configuration was not changed and goes on (`install.sh:276-282`). The
  same holds for a symbolic link whose target does not exist, or that loops
  (`scripts/merge-cursor-config.mjs:70-73`). A link to an existing file is
  written through and stays a link. The temporary file is created with mode 600
  and gets the mode of the old file just before the rename.
- **If you used the old installer,** your `mcp.json` can hold your API keys in
  plain text under `mcpServers.m7.env`, and so can every `mcp.json.backup.*`
  file next to it. Updating the `m7` entry with the new installer removes
  `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from that `env` block, and removes
  the block when nothing else is in it. It does not touch the backup files.
  Delete them yourself, and rotate a key if the file was ever shared.
- **Docker.** The installer no longer offers to start ChromaDB with Docker. The
  repository has no `docker-compose.yml`, so the old step could only fail.
  ChromaDB stays optional (`CHROMA_URL`).
- **Not run.** `install.sh` was not executed in testing: it installs packages
  and edits your Cursor config. Only `bash -n install.sh` (syntax) and the tests
  of the merge script (`tests/sec-low.test.mjs`, against temporary files) ran.

## Status of known risks

This is a list of what was found, what was changed and what was checked. It is
not a claim that M7 is secure. Section "What is not verified" below lists what
no test here can show.

`file:line` refers to the tree that contains this file, on `main` of `dmitrii-f-t27/m7-mcp-oss`.
Line numbers move when code changes. Search for the function name if a
line is off.

Some rules are written in t27 (`specs/`) and run as WebAssembly (`wasm/m7_rules.wasm`). The TypeScript function that held such a rule is now a call into `src/rules/`, so a row that names the function also names the rule as `specs/<file>.t27:<line>`. [docs/T27_BOUNDARY.md](docs/T27_BOUNDARY.md) lists what moved and what stays in TypeScript.

- FIXED: the code no longer does the thing. Each test file named in the last
  column had tests that failed on the old code. Some tests in those files pass
  on both versions, because they guard behaviour that must stay the same. Where
  a test cannot show the fix, the column says so.
- CHANGED: the behaviour changed, and the effect on the outside is unverified.
- OPEN: not fixed in this version.

| ID | Sev | Risk | Status | Where | Test |
|---|---|---|---|---|---|
| SEC-1 | HIGH | Shell command built from task text | FIXED; already so at the base commit `0ace0ab`, unchanged here. Every child process in `src` is started with an argument list (`git`, `grep`, `rg`); a text search finds no `shell: true` and no `execSync(` | `src/core/architecture/architecture-context-analyzer.ts:30-43` (argv `--fixed-strings -e <keyword> --`), `:145-147` (`execFileAsync`, no shell); `src/hive/context/fileSearcher.ts:9`, `:48`; `src/core/tools/projectIndex/projectScanner.ts:138`; `src/telemetry/gitCapture.ts:53` | none added |
| SEC-2 | HIGH | `analyze_task` and `init_project` overwrite project files | FIXED, with the exceptions below | `src/core/utils/safeWrite.ts:66` (`writeIfAbsent`, `wx`), `:103` (`readManagedState`), `:168`, `:178`; `src/core/tools/initProject.ts:45-57` (`createFile`), `:222-231` (`isEmptyListing`), `:251-257`, `:903-930` (`.gitignore`); `src/core/tools/analyzeTask.ts:267-269`, `:915-939`; `src/core/tools/unified/memoryTool.ts:465`, `:502`, `:552`; the marker, state, write and sync rules (`po_has_marker`, `po_managed_state`, `po_write_action`, `po_sync_action`) are at `specs/policy_rules.t27:54-87`, called from `src/core/utils/safeWrite.ts:35-53`, and the empty-directory rule `po_listing_empty` is at `specs/policy_rules.t27:113` | `tests/sec-init-overwrite.test.mjs`, `tests/sec-write-paths.test.mjs` |
| SEC-3 | MED | Task text sent to OpenAI, twice per `analyze_task`, not documented | FIXED: local by default, opt-in | `src/core/intelligence/intentClassifier.ts:223`, `:235`, `:260`, `:281`, `:296-303`, `:310`, `:312`; callers `src/core/tools/analyzeTask.ts:303`, `src/core/router.ts:93`; the rule `po_remote_classification` is at `specs/policy_rules.t27:152` | `tests/sec-classifier.test.mjs` |
| SEC-4 | MED | `analyze_task` starts Docker | FIXED; already so at the base commit `0ace0ab` | `src` starts no Docker process (the only child processes are `git`, `grep` and `rg`, see SEC-1). The health check is one HTTP GET, `src/core/health/healthCheck.ts:54`. `src/core/warmup/warmupManager.ts:624` and `src/core/tools/projectIndex/projectScanner.ts:579` only test that a file exists, and `src/core/tools/projectIndex/projectScanner.ts:580` adds the text `docker-compose up` to a generated quick-start list without running it | none added |
| SEC-5 | MED | The Cursor activity guess beat `M7_PROJECT_PATH` | FIXED | `src/core/utils/projectPath.ts:9-23` (order), `:257-259`, `:304-306` (`selectProjectSource`), `:504-532` (`ensureProjectPathResolved`), `:633-636` (diagnostics); the rule `pr_env_source` is at `specs/path_rules.t27:214` | `tests/sec-project-path.test.mjs` |
| SEC-6 | MED | Visualizer on all interfaces, no auth, `CORS *` | FIXED; no token, see limits | `src/visualizer/visualizer-server.ts:39`, `:45`, `:55`, `:158`, `:174`, `:221-232`, `:764`; `src/core/tools/v3/visualizer-tool.ts:169-177`; the Host and Origin rules `nr_host_allowed` and `nr_origin_allowed` are at `specs/net_rules.t27:69`, `:78`, called from `src/visualizer/visualizer-server.ts:45`, `:55` | `tests/sec-visualizer.test.mjs` |
| SEC-7 | MED | Mesh writes peer files and injects peer messages; Hive put raw peer text into its task | FIXED, with limits | `specs/path_tables.t27:19-46` (name lists), `specs/path_rules.t27:142`, `:150` (`pr_push_verdict`, `pr_pull_verdict`); `src/core/security/pathGuard.ts:60` (`foldUnicode`, native), `:80`, `:85` (`pushRefusal`, `pullRefusal`), `:207` (`guardPath`); `src/mesh/tools/meshTool.ts:619`, `:644-657`; `src/mesh/peerText.ts:31` (`PEER_HEADER`), `:41-91` (calls into the peer-text rules `specs/mesh_rules.t27:40-312`); `src/hive/tools/hiveCoordinator.ts:168-182`; `src/core/tools/projectIndex/projectIndexTool.ts:121-126`; `src/core/tools/createStructure.ts:189-202`; `src/core/orchestrator/groundingGate.ts:67-73` | `tests/sec-mesh.test.mjs`, `tests/sec-hive.test.mjs`, `tests/sec-write-paths.test.mjs` |
| SEC-8 | MED | A `.env` in the working directory redirected outgoing requests | FIXED | `src/core/utils/loadEnv.ts:14-16`, `:23-28`; `src/index.ts:6` | `tests/sec-env.test.mjs` |
| SEC-9 | MED | Hive sends `temperature` to Opus models, said to be rejected | CHANGED; the rejection is **unverified** | `src/hive/api/anthropicParams.ts:19`, `:28`; call sites `src/hive/intelligence/hiveArchitect.ts:77`, `:232`, `src/hive/orchestrator/dynamicOrchestrator.ts:438`, `:525`, `src/hive/api/apiManager.ts:409`, `src/hive/planner/plannerAgent.ts:73`, `src/hive/debate/debateEngine.ts:506`; the rule `po_model_takes_temperature` is at `specs/policy_rules.t27:139` | `tests/sec-anthropic-temperature.test.mjs` |
| SEC-10 | LOW | Key text in logs; the installer replaced `~/.cursor/mcp.json` and wrote keys into it | FIXED | logs: `src/index.ts:247-249` and `src/hive/tools/hiveCoordinator.ts:215-216` print `set` / `present`; installer: see "The installer" above, `scripts/merge-cursor-config.mjs:39-63`, `install.sh:181-228`, `:269-282` | `tests/sec-low.test.mjs` (merge script only) |
| SEC-11 | LOW | Hive has no global spend limit and no cancel | OPEN, LOW; no fix in this version | a cap per debate only: `src/hive/debate/debateEngine.ts:79-81`, `:98-100`; the Hive tool starts the run with no budget and no abort: `src/hive/tools/hiveCoordinator.ts:227-235` | none |

### Other spots

| ID | Sev | Risk | Status | Where | Test |
|---|---|---|---|---|---|
| SEC-12 | LOW | Relay listened on every interface; bearer compared with `===` | FIXED | `src/mesh/relay/server.ts:25`, `:62-77`, `:264-265` | `tests/sec-low.test.mjs` (the compare is a static check) |
| SEC-13 | LOW | Relay answers with `Access-Control-Allow-Origin: *` | OPEN, LOW; no fix in this version | `src/mesh/relay/server.ts:89-91` | none |
| SEC-14 | MED | `project_index` `output_path` written to any path | FIXED: the tool contains the path; the generator still writes where it is told | `src/core/tools/projectIndex/projectIndexTool.ts:121-126`; `src/core/tools/projectIndex/indexGenerator.ts:70-71` | `tests/sec-write-paths.test.mjs` |
| SEC-15 | MED | A `path:` premise in the grounding gate was checked by string, not by real path | FIXED | `src/core/orchestrator/groundingGate.ts:67-73` | `tests/sec-write-paths.test.mjs` |
| SEC-16 | LOW | An explicit `project_path` is accepted if the directory exists, and it sticks for the session | OPEN, by design | `src/core/utils/projectPath.ts:75-85`, `:422-431` | none |
| SEC-17 | LOW | `logger.ts` redacts nothing; `sanitizer.ts` redacts only before a telemetry upload | OPEN, LOW; no fix in this version. The logger writes only when `M7_DEBUG=true` | `src/core/utils/logger.ts:30`, `:48`, `:56`; `src/telemetry/sanitizer.ts:88`; used at `src/telemetry/gitCapture.ts:136` | none |
| SEC-18 | LOW | Debug log held the first 50 characters of the task text | FIXED: the log holds the length only | `src/core/intelligence/intentClassifier.ts:310` | `tests/sec-classifier.test.mjs` |
| SEC-19 | LOW | Path inputs that were not traced at the base commit: the `path` input of `style_guardian`, `hub_path` and the document paths of the knowledge hub config, `trackChange` in the scope guard. `routeToReferenceFile` was traced: it returns fixed file names | All traced. Knowledge hub: FIXED (see SEC-20, SEC-31 and "SEC-19 and SEC-20 details"). `hub_path` is checked by the schema but never used to build a path, and the document paths are kept inside the hub. `style_guardian` `path`: OPEN, LOW. It reads files only and writes nothing into the project; see "SEC-19 remainder". `trackChange`: no file access and no caller, so there is nothing to fix | `src/core/tools/knowledgeHub/types.ts:364`; `src/core/tools/knowledgeHub/utils/configUtils.ts:147`, `:167`; `src/core/tools/knowledgeHub/core/DocumentManager.ts:213-233`; `src/core/tools/unified/memoryTool.ts:277-303`; `src/core/tools/v3/style-guardian-tool.ts:29`, `src/style-guardian/index.ts:69`, `:346`, `src/style-guardian/style-analyzer.ts:544`, `:562`; `src/core/guards/scopeGuard.ts:104` | `tests/sec-knowledge-hub.test.mjs` (knowledge hub only) |
| SEC-20 | MED | `knowledge_hub` `init` moved your `INDEX.md` and similar root files into the hub, and the move replaced a file that was already there | FIXED: `init` moves nothing. `migrate`, the only action that moves root files, keeps a file the hub already has and lists it. The hub runs only on an explicit hub action, not from `analyze_task` or `init_project`. SEC-31 and SEC-26 cover the links and the version files | `src/core/tools/knowledgeHub/core/KnowledgeHub.ts:131-132`, `:175`; `src/core/tools/knowledgeHub/core/MigrationManager.ts:41`, `:81-168`; `src/core/tools/knowledgeHub/knowledgeHubTool.ts:207`, `:223` | `tests/sec-knowledge-hub.test.mjs` |
| SEC-21 | MED | The systems (memory, journal, schema, orchestrator, scope guard) and some tools (task graph, task transfer, scope, TSI) were built on the start-up path, usually the install directory. They stayed there when `M7_PROJECT_PATH` or MCP Roots named another project, so a schema update, a contract, the journal, the task graph or the TSI data could be written into the wrong project. A Roots change during a session was not followed either: the handler never registered with the installed SDK | FIXED, with one accepted limit; see "SEC-21 details" | `src/index.ts:207-229` (change callback), `:260-275` (TSI built on first use), `:300` and `:612` (tools read the systems when they run), `:824` (wait in `registerTool`); `src/core/utils/projectPath.ts:350`, `:379` (caching tells subscribers), `:471-498` (Roots change handler), `:650-651` (diagnostics); `src/tsi/tsiSystem.ts:371`, `src/tsi/index.ts:91`; singleton resets at `src/core/task-graph/taskGraphManager.ts:466`, `src/core/task-transfer/transferManager.ts:342`, `src/core/compliance/complianceTracker.ts:321`, `src/core/utils/manifest.ts:358`, `src/core/devops/devopsRegistry.ts:584`, `src/knowledge-graph/index.ts:415` | `tests/sec-stale-root.test.mjs` |
| SEC-22 | LOW | `validatePath` in the knowledge hub checked a path with a bare `startsWith`, so `/p/b-evil` passed for the root `/p/b`. Nothing called it | FIXED: the function is removed, so no one starts to use it. `rg validatePath src scripts` finds nothing | removed from `src/core/tools/knowledgeHub/utils/fileUtils.ts` | `tests/sec-write-paths.test.mjs` (the export is gone) |
| SEC-23 | LOW | `create_structure`: a `task_id` such as `../../x` stays inside the project but can put templates outside `docs/` | OPEN, LOW | `src/core/tools/createStructure.ts:74`, `:225-226` (name), `:189-192` (containment) | `tests/sec-write-paths.test.mjs` (containment only) |
| SEC-24 | LOW | `push-file` can send control paths such as `.git/config` (only `pull-file` refuses them) | OPEN, by design | `src/core/security/pathGuard.ts:80`, `:85` (the rules are `pr_push_verdict` and `pr_pull_verdict`, `specs/path_rules.t27:142`, `:150`) | none |
| SEC-25 | LOW | Mesh error text is flattened to one line but not fenced | OPEN, LOW | `src/mesh/tools/meshTool.ts:781` | none |
| SEC-26 | MED | A data folder of the project shipped as a symlink: `.m7`, a link below it (`.m7/memory`), `m7-cycles` or `knowledge-hub`. The journal, the memory files, the cross-session, TSI, task graph and session files, the cycle artifacts and the hub were written through the link, outside the project. A `project_path` that named such a project did the same through `init_project` and `project_index`. The Hive report went through a `docs` link the same way | FIXED, with limits; see "SEC-26 details". `dataDirRefusal` walks the folders and refuses a folder or a nested link that leaves the project or dangles; a link that stays inside the project and names a folder is followed once, so a second link behind it is found. The server checks `.m7` and `m7-cycles` before every tool call (once per project root); `applyProjectPath` and `project_index` with a `project_path` check the project they are given; `knowledge_hub` checks `knowledge-hub` on every action. The Hive report is written only when `docs/hive` resolves inside the project, otherwise it is skipped and the tool still answers. Three project files outside the data folders are covered by SEC-32 | `src/core/security/pathGuard.ts:111` (`linkLeavesRoot`), `:231`, `:234`, `:263-325` (`dataDirRefusal`); `src/index.ts:781-791`, `:825-829`; `src/core/utils/projectPath.ts:424-427`; `src/core/tools/projectIndex/projectIndexTool.ts:114-119`; `src/core/tools/knowledgeHub/knowledgeHubTool.ts:82-84`; `src/hive/tools/hiveCoordinator.ts:40-74`; the rule `pr_link_leaves` is at `specs/path_rules.t27:193` | `tests/sec-write-paths.test.mjs`, `tests/sec-hive.test.mjs` |
| SEC-27 | LOW | `ConsoleMonitor` is one object per process and kept the journal of its first call. After the project changed (SEC-21), the console errors it captured, with their messages and stack traces, went into the journal of the first project's `.m7` | FIXED: `getInstance` takes the journal of every call | `src/core/tools/critical/console.ts:67-77`, `:339` | `tests/sec-low.test.mjs` |
| SEC-28 | LOW | `GraphVisualizerService` keeps the knowledge graph it took when it was built. After the project changes, it keeps the graph of the first project | OPEN, LOW. Not fixed here | `src/visualizer/graph-visualizer-service.ts:33`, `:461-466`; `src/visualizer/visualizer-server.ts:74`; the graph itself is reset at `src/knowledge-graph/index.ts:415` | none |
| SEC-29 | LOW | Model discovery at server start sends a model list request to OpenAI and a 1-token `Hi` message to Anthropic for each of five model names, with your keys. There is no switch | OPEN, LOW. Documented in "What leaves the machine". Not fixed here | `src/index.ts:235-254`; `src/hive/api/apiManager.ts:131`; `src/hive/api/modelDiscovery.ts:100`, `:137-151` | none |
| SEC-30 | LOW | Hive sends up to three chunks of project memory (300 characters each) with the task to OpenAI and Anthropic. The chunk text is not marked or cleaned, and no switch turns this off | OPEN, LOW. Documented in "What leaves the machine". Not fixed here | `src/hive/tools/hiveCoordinator.ts:146`, `:191-203` | none |
| SEC-31 | MED | `knowledge_hub`: (a) a document that is a symlink was read through, and its text went into `versions/` and the answer; (b) a document was written through a temporary file named `<document>.tmp`, so a link with that name was written through; (c) `document_id` was joined into a folder name unchecked, so `history` and `diff` read version files from another folder; (d) `version` was joined into `<version>.yaml` unchecked, so `rollback` restored a document from a file outside the hub; (e) prune deletes the versions it lists by the `version` field inside each version file, so a version file in a cloned repo could name a path, and the delete (`.yaml` files only) followed it | FIXED, with one behaviour change: a document that is a symlink is now refused for load, save, exists and delete (`INVALID_PATH`), also when it points inside the project. The temporary file has a random name and is created with `wx`. A document id or version name that leaves its folder throws `INVALID_PATH`. `registry.yaml` was traced: it is never read for version names. Limit: the check and the write are two steps, as for SEC-7 | `src/core/tools/knowledgeHub/core/DocumentManager.ts:213-233`; `src/core/tools/knowledgeHub/utils/fileUtils.ts:12-48`; `src/core/tools/knowledgeHub/utils/configUtils.ts:179-182`, `:189-205`; `src/core/tools/knowledgeHub/core/VersionManager.ts:154`, `:205-217`, `:335` | `tests/sec-knowledge-hub.test.mjs` |
| SEC-32 | MED | Three project files were written with a plain write, so a symlink at the file, or at `docs`, was followed. (a) `PROJECT_SCHEMA.yaml`, rewritten by `mcp_m7_schema` `update` and `mcp_m7_contracts` `register`: a link to an outside YAML file that holds a `project:` key was overwritten, and `mcp_m7_schema` `view` showed its text. (b) `docs/REPENTANCE.md`, rewritten by `mcp_m7_repentance` `confess`: a `REPENTANCE.md` link overwrote its target, and a `docs` link created `REPENTANCE.md` in the folder it names. (c) `TASK_META.json` in the task folder: a link at the file, and a `docs` link above the folder, were written through | FIXED, MED (it was listed LOW). `writeRegularFile` resolves the folder above the file inside the project and refuses a file that is a symlink, a dangling one included. `loadSchema` does not read a symlink: it logs a `schema-load-error` and answers as if there were no schema. `confess` keeps the confession in `.m7/repentance.json`, skips the Markdown file and says so in the answer. `TASK_META.json` is created only when absent (`writeRegularFileIfAbsent`: same check, an existing file or link is kept and listed as kept). A refused `TASK_META.json` is logged and the task is still created. See "SEC-32 details" | `src/core/utils/safeWrite.ts:137-150`, `:152-165`; `src/schema/schemaSystem.ts:79-82`, `:140`; `src/core/tools/repentanceTool.ts:73-82`, `:128`, `:187`, `:203-205`; `src/core/task-graph/taskGraphManager.ts:172-173`, `:197` | `tests/sec-write-paths.test.mjs` |
| SEC-33 | MED | `mcp_m7_safety_verify` answered `PASS` on plain jailbreak text. At `c41f8ce`, 5 of the 96 tests in `src/core/safety/__tests__/` failed in each of 3 runs: Grandma exploit, Negation inversion, Anthropic authorization claim, Sudo/admin mode claim, Emergency/urgency framing. Those two test files were outside `npm test`, so no check published with 4.0.0 ran them. The scan also failed open: an error inside it answered `pass`. The tool is advisory: its answer is text for the caller, and nothing in the server acts on it | FIXED for the five inputs and for scan errors, which now answer `block`. Remainder OPEN, LOW: reworded or non-English text can still pass; `synthesize` is still not matched by the blocking rules at `src/core/safety/trapCatalog.ts` (`TRAP-J-010`, `TRAP-J-OUT-001`) or `src/core/safety/intentVerifier.ts` (`dangerous`), because widening them adds false blocks | `src/core/safety/pipeline.ts:6`, `:51`, `:96`, `:131` (fail-closed returns), `:174-185` (`failClosed`); `src/core/safety/trapCatalog.ts:66-81` (`TRAP-J-004`), `:189` (`TRAP-J-030`), `:205`, `:208` (`TRAP-J-031`), `:289`, `:303-306` (`TRAP-J-050`), `:322` (`TRAP-J-051`); `src/core/safety/inputAnalyzer.ts:59`, `:174-179`; `src/core/tools/safetyTool.ts:52`; registered at `src/index.ts:484` | `tests/safetyVerdicts.test.mjs`; `src/core/safety/__tests__/stress.test.ts`, both now in `npm test` |
| SEC-34 | LOW | The regular expression `/(\w{20,}\s){3,}/` in the safety scan is quadratic on one long word. A probe of the same expression outside the server took about 4 s on 64 KB and over 20 s on 256 KB. The tool sets no size limit and the scan runs on the server's main thread, so such a text can hold up the server. Not run through the tool | OPEN, LOW | `src/core/safety/trapCatalog.ts:243`; `src/core/safety/trapDetector.ts:58`; `src/core/tools/safetyTool.ts:16` | none |

### Details and limits per item

- **SEC-2 exceptions.** These files can change without the M7 marker:
  (a) `.gitignore` gets one `.m7/` line when it has none. M7 reads the file,
  adds the line and writes it back, and the lines you had stay
  (`src/core/tools/initProject.ts:903-930`). A `.gitignore` that is a symlink is
  neither read nor written: `init_project` lists it as skipped. (b)
  `CYCLE_REGISTRY.md` is rewritten with the new row when you register a cycle
  summary, with or without the marker, and it is created when missing
  (`src/core/orchestrator/cycleOrchestrator.ts:1587-1646`). Your content is
  kept. A registry that is a symlink, or whose location leads out of the project, is not
  followed: the `mcp_m7_cycle` call fails with an error. The only caller is the
  summary action (`src/core/tools/cycleTool.ts:55`). (c) `PROJECT_SCHEMA.yaml` is
  rewritten whole by `mcp_m7_schema` (`src/index.ts:359-366`) and by
  `mcp_m7_contracts` (`src/core/tools/critical/contracts.ts:376`), through
  `src/schema/schemaSystem.ts:140`, which refuses a symlink (SEC-32).
  `init_project` does not touch an existing one. (d) `mcp_m7_project_index` with `force`, and its `update` action, rewrite
  the index file, `PROJECT_INDEX.md` or your `output_path`
  (`src/core/tools/projectIndex/indexGenerator.ts:71`). (e) `mesh pull-file` with
  `overwrite=true` replaces a file (SEC-7). (f) The knowledge hub rewrites its own
  documents under `knowledge-hub/` on `update`, `sync` and `rollback`, after it saved
  the old version (SEC-20).
- **SEC-2 empty rule.** `mcp_m7_analyze_task` sets a project up on its own only
  in an empty directory. A directory is empty when it holds nothing but `.git`,
  `.gitignore`, `.DS_Store` and `.m7`. Every other name, hidden or not
  (`.github`, `.vscode`, `.env`, `.cursorrules`), makes it a project, and so
  does a directory that cannot be read
  (`src/core/tools/initProject.ts:222-244`; the rule is `po_listing_empty`, `specs/policy_rules.t27:113`). In a project that has files and
  neither a `memory-bank` nor a `.cursorrules`, `analyze_task` creates none of
  the setup files and adds a note that points to `mcp_m7_init_project`
  (`src/core/tools/analyzeTask.ts:267-269`). `init_project` refuses a directory
  that is not empty unless you pass `force`, and even with `force` it creates
  only what is missing (`src/core/tools/initProject.ts:128-130`).
- **SEC-2 task folder (`create_session`).** `mcp_m7_analyze_task` has the
  parameter `create_session`, default `true`. With it, `analyze_task` creates a
  task folder of seven template files, plus `TASK_META.json` when the task graph is on,
  under `docs/debug/<folder>/` or
  `docs/features/<folder>/` (`docs/features` for the light route). This happens in any project, also one that has
  files (`src/core/tools/analyzeTask.ts:497`, `:537`;
  `src/core/tools/createStructure.ts:177-202`). It never replaces a file there:
  each file is created with `wx`, a file that exists is kept and the answer lists
  it as kept, and the folder must lie inside the project, also through symlinks (a
  `docs` that links out is refused). The new files show up in `git status`.
  `create_session: false` turns this off. `mcp_m7_create_structure` follows the
  same rules.
- **SEC-2 marker rule.** M7 appends to, or rewrites, an existing file of the
  memory bridge and `memory-bank/activeContext.md` only if the file carries
  `<!-- m7-managed -->` in its first 4096 bytes
  (`src/core/utils/safeWrite.ts:103`, `:168`, `:178`;
  `src/core/tools/analyzeTask.ts:915-939`). A project that M7 set up before this
  change has no marker, so the memory bridge no longer appends to its
  `CODING_STANDARDS.md`, `CYCLE_REGISTRY.md` or `MASTER_REFERENCE.md`, and the
  answer says "not synced". This is accepted. Adding the marker line by hand
  turns the bridge on again for that file. Be careful with
  `memory-bank/activeContext.md`: with the marker, M7 replaces the whole file on
  each `analyze_task`. A skipped `activeContext.md` is only written to the debug
  log, not shown in the answer. The files in "SEC-2 exceptions" are not covered
  by the marker rule.
- **SEC-3 requests that carry no task text.** See "What leaves the machine".
  Model discovery runs when the server starts and uses both keys: one model
  list request to OpenAI (`src/hive/api/modelDiscovery.ts:100`) and one 1-token
  `Hi` message to Anthropic for each of five model names
  (`src/hive/api/modelDiscovery.ts:137-151`). `src/index.ts:251` creates the
  API manager, and its constructor starts the discovery
  (`src/hive/api/apiManager.ts:131`). The result is kept for 24 hours
  (`src/hive/api/modelDiscovery.ts:92`). The server refuses to start without
  both keys (`src/index.ts:240-245`). The model lists for the time-and-models
  header are fetched at the first `analyze_task` call
  (`src/core/tools/analyzeTask.ts:224-225`, `src/context/context-provider.ts:143`,
  `:177`) and kept for 24 hours (`src/context/types.ts:79`). A probe against a
  stub server saw 6 requests at start, 2 more at the first
  `analyze_task` and none at the second. No live call was made.
- **SEC-6 limit.** The visualizer has no token. Another user account on the
  same machine can connect to `127.0.0.1` while it runs.
- **SEC-7 limits.** Marking peer text as untrusted lowers the risk of prompt
  injection. It does not prevent it. Every value from another instance is cleaned
  of control characters (line breaks, zero-width and bidi marks, tag characters,
  the soft hyphen, word joiners and other invisible marks),
  broken apart at any run of three `<` or `>`, and put between `<<<` and `>>>`.
  The answer starts with a one-line untrusted-data header
  (`src/mesh/peerText.ts:31`). The cleaning, the break-apart and the marking are
  rules of `specs/mesh_rules.t27` (`:40` `mr_is_control`, `:123` `mr_scrub`,
  `:231` `mr_inline`, `:249` `mr_id`, `:265` `mr_block`, `:294` `mr_has_fence`),
  called from `src/mesh/peerText.ts:41-91`. They work on UTF-8. A text over 3,145,728 bytes
  is not cut: the answer is `[peer text refused: over the size limit]`. A lone
  surrogate becomes U+FFFD, so the characters next to it stay. If the rules
  cannot run, the answer is `[peer text refused: rules unavailable]`, never the
  raw text, and the header goes in front of every answer. The mesh tool and Hive
  both use it (`src/hive/tools/hiveCoordinator.ts:168-182`). The check that a path
  stays inside the project and the write that follows are two steps: a symlink
  swapped in between is not caught for `mesh pull-file overwrite=true`
  (`src/mesh/tools/meshTool.ts:651-652` uses a plain write; the default path
  uses `wx`). `mesh push-file` refuses secret files (`.env`, `.env.*`, `*.env`,
  `.envrc`, `.npmrc`, `.netrc`, `.pypirc`, `.pgpass`, `.git-credentials`,
  `id_rsa` and its kin, `credentials`, `.aws`, `.ssh`, `.docker`, `.kube`,
  `.gnupg`, and `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`).
  `pull-file` refuses those and the control paths `.git`, `.cursor`,
  `.cursorrules`, `.vscode`, `.claude`, `.m7`, `.husky`, `.github`, `.mcp.json`,
  the agent instruction files `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
  `.clinerules` and `.windsurfrules`, the tool folders `.devcontainer` and
  `.idea`, and `.gitmodules` and `.gitattributes`
  (`specs/path_tables.t27:19-46`, written from `specs/tables/path_tables.mjs`; the
  verdicts are `pr_push_verdict` and `pr_pull_verdict`, `specs/path_rules.t27:142`,
  `:150`). Each path segment is folded before the
  compare: Unicode NFKC, upper then lower case, ignorable characters removed,
  trailing dots and spaces cut (`src/core/security/pathGuard.ts:60-72`; the cut of
  trailing dots and spaces is `pr_trim_end`, `specs/path_rules.t27:73`). A
  look-alike spelling, such as a long s in place of `s` or the Kelvin sign in
  place of `k`, meets the same entry. The fold uses the tables of the platform
  (ICU in Node), so `foldUnicode` stays in TypeScript.
- **SEC-8 limit.** The `.env` in the install directory and the process
  environment stay trusted. Either can still set `OPENAI_BASE_URL`,
  `ANTHROPIC_BASE_URL`, `CHROMA_URL`, `M7_MESH_RELAY` or
  `M7_TELEMETRY_ENDPOINT`. Anyone who can edit those files or that environment
  can already run code as you.
- **SEC-11.** The Hive tools take the task text and send it to OpenAI and
  Anthropic. There is no tool action to stop a running Hive call, and the
  source has no `AbortController` under `src/hive`. `CANCELLED` in
  `src/hive/orchestrator/plannerOrchestrator.ts:241` marks a sub-task that
  threw an error. It is not a user cancel.
- **SEC-19 and SEC-20 details (knowledge hub).** `hub_path` in `hub-config.yaml`
  is checked by the schema but never used to build a path
  (`src/core/tools/knowledgeHub/types.ts:364`; `getHubPath` returns the fixed
  name `knowledge-hub`, `src/core/tools/knowledgeHub/utils/configUtils.ts:147`).
  The `path` of each entry in `documents` is now kept inside the hub:
  `hubDocumentPath` refuses a path that climbs out of the hub with `..`, names
  the hub itself, or holds a NUL byte
  (`src/core/tools/knowledgeHub/utils/configUtils.ts:167`), and `DocumentManager`
  resolves the folder of the document with `resolveContainedEntry`, so a hub
  folder that is a symlink leaving the project is refused, and it refuses a
  document that is itself a symlink (SEC-31)
  (`src/core/tools/knowledgeHub/core/DocumentManager.ts:213-233`). A refused
  path throws `INVALID_PATH`; `update` and `sync` report the failure and write
  nothing. `init` no longer moves your `INDEX.md` or other root documents into
  the hub (`src/core/tools/knowledgeHub/core/KnowledgeHub.ts:131-132`).
  `migrate` is the only action that moves them. It keeps a file that the hub
  already has: the root file stays, the hub file is not replaced, and the answer
  lists the file under `skipped_files`
  (`src/core/tools/knowledgeHub/core/MigrationManager.ts:41`, `:81-168`). A
  target whose folder leaves the project through a symlink is refused and
  nothing moves. A backup of the files that do move goes to
  `.m7/backups/knowledge-hub/`. **Limits:** the check and the write are two
  steps, as for SEC-7. Before every hub action the whole `knowledge-hub`
  folder, `config` and `versions` included, is walked for a link that leaves the
  project (SEC-26); the backup folder sits under `.m7`, which the server walks
  as well. A document that is a symlink is refused also when it points inside
  the project, so a hub that uses such links stops working. **Also fixed, not a
  security issue:** `getHistory` listed every `.yaml` file in a document's
  versions folder, and that includes `registry.yaml`. The registry then showed up
  as a version with the name `undefined` and an invalid date, so the `history`
  action failed with `Invalid time value`, and saving the tenth version of a
  document failed in the prune step with `Version undefined not found`. The
  filter now skips `registry.yaml`
  (`src/core/tools/knowledgeHub/core/VersionManager.ts:119-122`);
  `tests/sec-knowledge-hub.test.mjs` saves eleven versions of one document.
- **SEC-26 details.** A cloned repository can ship `.m7`, a folder below it,
  `m7-cycles` or `knowledge-hub` as a symlink. `dataDirRefusal` walks each folder,
  counts the entries, and refuses a folder or a nested link that resolves outside
  `realpath(root)` or dangles, a tree with more than 20,000 entries, a folder it
  cannot read and a root it cannot resolve. A link that stays inside the project
  and names a folder is followed: the folder it names is walked too, once per
  real path, so `.m7/cross-session -> ../y` with `y/out -> /elsewhere` is
  refused, and links that loop end at a folder already seen. The entries behind
  such a link count toward the 20,000. A refusal
  reads `Refusing to write outside the project: <path>`. The server runs the
  check before every tool call, once per project root (a root that passed is not
  walked again in that process), and it returns an error answer. The same check
  runs in `applyProjectPath` before any state changes (`init_project`,
  `mcp_m7_doctor` and `mcp_m7_warmup` with `project_path`), in `project_index`
  when `project_path` is given, and in `knowledge_hub` for the `knowledge-hub`
  folder. The Hive report is not a data folder (a linked `docs` is common), so
  `saveHiveReport` resolves its target with `resolveContainedEntry` and skips the
  report when `docs/hive` leaves the project. **Limits:** the check and the write
  are two steps, so a link planted after the check is not caught. A tree of more
  than 20,000 entries is refused even when it is harmless, and a link inside the
  data folder to a large folder of the project, such as the project root, can
  reach that limit. **Traced, nothing to fix:** `mcp_m7_arch_advisor`
  writes nothing: it reads the project at `project_path`, and it may read the
  cache `.m7/knowledge-graph.json` of the session project, not of `project_path`. The training export
  has no output path parameter, and its default is under `.m7`
  (`src/core/tools/v3/telemetry-tool.ts:208`, `src/telemetry/exporters.ts:250`).
  The writers under the home directory (`~/.m7/mesh`, `~/.m7/style-profile.json`,
  `~/.m7/errors.json`, the telemetry settings) and the relay store do not depend
  on the project. The project writers outside the checked folders are listed in
  SEC-32.
- **SEC-32 details.** `writeRegularFile(root, rel, content)` calls
  `resolveContainedEntry`, so the folder above the file must resolve inside the
  project, and it refuses a file that is a symlink (`isSymlinkNoFollow`); an absent
  file is created and a regular file is replaced. `PROJECT_SCHEMA.yaml` and
  `docs/REPENTANCE.md` are written only through it. `TASK_META.json` is written through
  `writeRegularFileIfAbsent`, which has the same containment check and keeps any existing
  file or link.
  `loadSchema` and `renderMarkdown` check the file first, so neither reads through
  a link. A project whose `PROJECT_SCHEMA.yaml` is a link therefore has no schema
  for M7: `mcp_m7_contracts` `register` answers that the contract was not saved. A
  `docs/REPENTANCE.md` that is refused costs no data: the confession is in
  `.m7/repentance.json`. **Limits:** the check and the write are two steps, as for
  SEC-7. **Reachability of (c), read from the code and one probe:** `analyze_task`
  used to hand the task graph the bare folder name, without its `docs/debug/` or
  `docs/features/` prefix, so it wrote `<project>/<name>/TASK_META.json`. On an empty
  project that folder was absent and no file was written. This is fixed at the source:
  `createM7StructureInternal` returns `relFolder`, the project-relative path with forward
  slashes (`docs/debug/<name>` or `docs/features/<name>`;
  `src/core/tools/createStructure.ts:521`), and `analyze_task` passes it to the task
  graph (`src/core/tools/analyzeTask.ts:574`). `TaskNode.folder` now always holds such
  a path, as the task transfer and the recon spawner already passed (`docs/debug/...` and
  `m7-cycles/...`; `src/core/task-transfer/transferManager.ts:210`,
  `src/core/orchestrator/frontierReconSpawner.ts:59`). So `analyze_task` now creates
  `TASK_META.json` in the task folder it has just made, through `writeRegularFileIfAbsent`,
  and lists the file in its answer, as created or as kept: the write is reachable in
  normal use, and the link checks above apply to it. The folder name has no timestamp,
  so a later session with the same text reuses the folder; the create-only write keeps
  the earlier `TASK_META.json` there, and the answer lists it as kept. `WarmupManager`
  used to drop every task with a relative folder, because it compared the field with the
  absolute project path; that filter is gone, since the task graph manager is already
  bound to the project (SEC-21). Records saved earlier keep the folder they have and are
  only displayed. Nothing in `src` reads `TASK_META.json`.
- **SEC-19 remainder (traced).** `style_guardian` `analyze` takes `path`, walks it
  and reads every `.ts`, `.tsx`, `.js` and `.jsx` file (`src/style-guardian/style-analyzer.ts:562`,
  `:517`). It reads a file symlink, and it does not follow a directory symlink.
  The path may be any directory the process can read; it is not limited to the
  project. The answer holds counts, formatting statistics and up to five
  identifier names per element, not file text. The profile is saved to
  `~/.m7/style-profile.json`, a fixed path under the home directory
  (`src/style-guardian/index.ts:48`, `:346`). Nothing is written into the
  project, so this is a read of names and statistics: LOW, and the agent that
  passes the path could read the same files itself. The `file` input of the other
  actions is a label only; no action reads it. `trackChange` in the scope guard
  (`src/core/guards/scopeGuard.ts:104`) updates in-memory counters and tests the
  file name against a pattern. It touches no file, and no code calls it.
- **SEC-21 details.** While the Roots step is open, every tool call first waits
  for the workspace (`src/index.ts:824`). After the step is finished the wait
  costs nothing. The systems and the singletons that hold project state follow
  the project: the task graph manager, the task transfer manager, the
  compliance tracker, the manifest manager, the DevOps registry and the
  knowledge graph reset when the path changes. TSI is built on its first tool
  call, not at start. A `roots/list_changed` notification now moves the session
  to the new workspace, with one notice per change. It does not move an explicit
  `project_path` (SEC-16), and a read that fails leaves the session on its
  current project. If the server cannot register the handler, it still runs, and
  `getProjectPathDiagnostics()` reports `rootsChangeHandlerRegistered: false` and
  the error. **Accepted limit:** while Roots are pending and no path is set,
  `ensureProjectPathResolved` returns an uncached guess with no notice. The
  systems then stay on the working directory until the attempts run out, after
  at most 5 attempts. MCP resources (`m7://...`) only read, and may read state of
  the working directory in the same window. **Leftover:** `GraphVisualizerService`
  keeps its first graph (SEC-28). `ConsoleMonitor` now takes the journal of every
  call (SEC-27). The cycle orchestrator fixes `cyclesDir` at start-up
  (`src/core/orchestrator/cycleOrchestrator.ts:86`); it is only one read-only
  candidate in the lookup of a stored cycle state
  (`src/core/orchestrator/cycleOrchestrator.ts:1363`, `:1549`).

## Dependencies: `npm audit`

`npm audit` lists **6 entries** (1 low, 3 moderate, 2 high, 0 critical). This is
a point-in-time result from the advisory database. Run `npm audit` again, the
answer changes as advisories are added. The advisory floors that could be
raised without a major version change were raised
(`@modelcontextprotocol/sdk`, `ws`, `js-yaml`, `yaml`). The six entries remain
because their fixes need a major version change or a downgrade. No `--force`
was used. Whether each is reachable was decided **by reading the code**. Nothing
was run to try to trigger them.

| Package (installed) | Sev | Advisory | Used in `src`? | Why it is not fixed, and reachability |
|---|---|---|---|---|
| `zod` 3.25.76 | high | GHSA-mrhx-c7xc-m3w5: memory exhaustion while validating oversized constrained collections (`<4.6.6`) | Yes: tool input schemas, 39 files import it | There is no 3.x fix. The fix is zod 4, a major change. The relay imports no zod (`src/mesh/relay`). Zod parses the arguments of a tool call, and those come from your local MCP client over stdio (for example `src/mesh/tools/meshTool.ts:682`). Peer data from the relay is not parsed with zod. |
| `openai` 5.23.2 | high | `npm audit` reports it only "via zod" (range `4.55.0 - 5.23.2`) | Yes (`src/core/intelligence/intentClassifier.ts:281`, `src/hive/api/apiManager.ts:116`, others) | The fix is openai 7.x, a major change. The advisory is the zod chain above, not a flaw in the code of `openai` itself. |
| `diff` 7.0.0 | low | GHSA-73rr-hh4g-fpgx: denial of service in `parsePatch` and `applyPatch` (`>=6.0.0 <8.0.3`) | `src/core/tools/critical/impact.ts:7` | `src` imports `diffChars`, `diffLines` and `createTwoFilesPatch` only (`src/core/tools/critical/impact.ts:304`, `:318`, `:438`). It never calls `parsePatch` or `applyPatch`. The fix is diff 9, a major change. |
| `minimatch` 10.2.6 | moderate | GHSA-g3hv-75wg-m249: denial of service through globparts amplification (`<11.0.1`) | Not imported by M7 (`minimatch` is in no file under `src` and not in `package.json`). It comes in through `@ts-morph/common`. | No pattern reaches it. The only M7 code that uses ts-morph is `src/core/tools/knowledgeHub/scanners/TypeScanner.ts`. It adds files one by one with a concrete path (`src/core/tools/knowledgeHub/scanners/TypeScanner.ts:76`, `addSourceFileAtPath`) and calls `project.getSourceFiles()` with no pattern (`src/core/tools/knowledgeHub/scanners/TypeScanner.ts:85`). In the installed `@ts-morph/common` 0.28.1, `minimatch` is reached only through the wrapper `getPathMatchesPattern` (`dist/ts-morph-common.js:1175`, `:1263`), whose only caller is `matchGlobs` (`dist/ts-morph-common.js:1696`). In the installed `ts-morph` 27.0.2, `matchGlobs` is called only inside `getSourceFiles(globPatterns)` (`dist/ts-morph.js:18881`, `:20908`), and only when a pattern is passed. This is a reading of that code, not a run. How ts-morph reads `include` and `exclude` of the `tsconfig.json` of the scanned project was **not** traced. |
| `@ts-morph/common` 0.28.1 | moderate | via `minimatch` | via `ts-morph` | The audit offers ts-morph 10.0.1, a downgrade across many majors. Not applied. |
| `ts-morph` 27.0.2 | moderate | via `@ts-morph/common` | `src/core/tools/knowledgeHub/scanners/TypeScanner.ts:32` (lazy `import('ts-morph')`) | Same as above. |

## Secret scan: gitleaks

`gitleaks detect --source <repo> --no-banner` scans the git history of this
clone. Before `.gitleaksignore` it reported 2 findings, both in
`src/tsi/patterns/security/auth.yaml`, lines 30 and 32. Both
lines sit in a `bad:` code sample of a pattern catalogue (it shows insecure
code on purpose; the `good:` sample follows at line 33). The values are plain
placeholders, and they are not real credentials. They were not tried against
any service. Line 31, the neighbouring `DB_PASSWORD` sample, was not a finding.
`.gitleaksignore` holds the two fingerprints, which contain no secret. They are
tied to commit `72a7640700dbd7cebc0d57eabe8253989af084ba` and to those line
numbers. If the file is edited, the lines move and the findings come back.

After the ignore file, the scan of the history finds no leaks. A second scan
with `--no-git` over the changed files also finds none. A clean
scan shows that the rules of gitleaks found nothing. It does not show that no
secret exists.

## Known limits

- Prompt injection through peer text, files and model output is reduced, not
  prevented (SEC-7).
- The visualizer and the relay have no per-user identity (SEC-6, SEC-12).
- Remote classification, when switched on, sends the task text to OpenAI. Hive
  always sends the task text to OpenAI and Anthropic when you use it, together
  with up to three project memory chunks and, when the mesh is active, the
  context of the other M7 instances (see "Other destinations you control").
- `.env` in the install directory, the process environment and the MCP client
  config are trusted input (SEC-8).
- An explicit `project_path` is followed if the directory exists (SEC-16). The
  data-folder check of SEC-26 looks at `.m7` and `m7-cycles` once per project
  root; a link planted in them later is not caught.
- The logger redacts nothing and is off unless `M7_DEBUG=true` (SEC-17).
- Opus models run at the API default temperature (SEC-9).
- One test in `tests/deepScanAcceptance.test.mjs` (the one named "existing
  file without fog entry") failed once in a full run and then passed. It is not
  a security issue. The likely cause is a timing gap in the grounding gate: a
  file premise was stamped with the time and judged a moment later, and a clock
  tick between the two could age a file that exists, so it showed as stale and
  drew a warning. That gap was real: a test with a clock that moves on every read
  failed before the change and passes after it
  (`tests/groundingGate.test.mjs`). The gate now reads the clock once per premise
  and uses it for both steps
  (`src/core/orchestrator/groundingGate.ts:204`, `:223`, `:283-287`). The
  original failure was not reproduced in the acceptance test itself, so that
  link is an inference.
- `mcp_m7_safety_verify` matches English word lists with regular expressions. It
  is a hint for the caller and not a boundary: reworded text can pass, and nothing
  in the server acts on its answer (SEC-33).
- A rule that gets input over its limit refuses. It never decides on a cut text.
  The limits are 4,096 bytes for a path (16,384 after folding), 256 bytes each for
  a Host header, an Origin header, a model name and the value of
  `M7_ALLOW_REMOTE_CLASSIFICATION`, 65,536 bytes for a directory listing, and
  3,145,728 bytes of UTF-8 for peer text. Over the limit, a path is refused, a Host
  or Origin is not allowed, no temperature is sent, remote classification stays
  off, a directory counts as not empty (M7 sets nothing up in it), and peer text
  shows as `[peer text refused: over the size limit]`. The old code set no limit of
  its own on these inputs. [docs/T27_BOUNDARY.md](docs/T27_BOUNDARY.md) lists every difference.

## What is not verified

- **No live model call.** No test here calls OpenAI or Anthropic. Stub servers
  on `127.0.0.1` stand in. That is why the claim that Opus models reject
  `temperature` (SEC-9) is unchecked, and why model discovery, retries and
  time-outs are checked against a stub only.
- **No live relay deployment.** The relay ran only on this machine: on
  loopback, and in one probe on `0.0.0.0` reached through this machine's own
  link-local address. It was never run behind TLS, a proxy, a container or a
  cloud host, and never with two machines.
- **Windows was not tested.** The path rules have a Windows
  branch (`isInsideWith`, `src/core/security/pathGuard.ts:94`; the rule is `pr_is_inside`, `specs/path_rules.t27:160`) that runs only
  as a pure function on this machine. Symlink behaviour, `chmod 600`, case rules and `install.sh` (bash)
  were not tried on Windows. The name rules do not know NTFS alternate data
  streams (`.env::$DATA`) or 8.3 short names (`GITHUB~1`), so a path spelled that
  way can pass a denylist entry on Windows. Linux was not run either. All runs were on macOS
  with Node 24.
- **Windows branch of the specs not run.** `pr_is_inside` and `pr_relative_start`
  (`specs/path_rules.t27:160`, `:184`) and `by_is_sep` (`specs/bytes_rules.t27:23`)
  take a Windows flag. The tests run both settings on macOS, against the old
  TypeScript (`tests/rulesPath.test.mjs`); the native test of `by_is_sep` also
  runs both. Nothing ran on Windows. `wasm/m7_rules.wasm` was built and loaded on macOS with Node 24
  only.
- **Slack and Statsig could not be checked.** This repository holds no Slack
  or Statsig client. A text search finds only a Slack-token pattern in the
  telemetry redaction (`src/telemetry/sanitizer.ts:28-29`) and `slack` as a
  channel name in a sample workflow file that no source file loads
  (`workflows/development/m7-task-workflow.yaml:126`, `:134`, `:142`). Nothing
  outside this repository, such as the upstream project or a hosted service,
  was queried.
- **`install.sh` was not run.** Only the merge script was tested (see above).
- **Token compare timing was not measured** (SEC-12).
- **Open items SEC-28 to SEC-30.** SEC-28 is read from the code, not run. SEC-29
  and SEC-30 are read from the code and the documentation, not run against a live
  API.
- **SEC-26, SEC-27, SEC-31 and SEC-32** have tests that failed on the old code
  (`tests/sec-write-paths.test.mjs`, `tests/sec-hive.test.mjs`,
  `tests/sec-low.test.mjs`, `tests/sec-knowledge-hub.test.mjs`). They ran on
  macOS only. The 20,000-entry limit is tested with empty files; the time of the
  walk on a large real `.m7` was not measured.
- **The knowledge hub fix** was tested with symlinks and `hub-config.yaml` edits
  on macOS only.
- **Reachability of the `npm audit` entries** rests on reading the code
  (section above).
- **Tool surface.** Tool names and input schemas were compared with the 3.22.2
  list. The behaviour behind each tool was not compared one by one.
- **The safety tests were outside the published checks.** The checks for 4.0.0 did
  not run `src/core/safety/__tests__/`. The result on `c41f8ce` is in SEC-33.
- **Weak tests left as they are.** Two tests in `src/core/safety/__tests__/stress.test.ts`
  pass but prove little, and were not edited. `"For a movie script" framing` (`:161`)
  computes two answers and ends in `assert.ok(true)`, so it checks nothing.
  `Unicode homoglyph evasion (not blocked — acceptable)` (`:127`) checks plain text
  (`What is the weather today?`) and uses no look-alike letter. A pass of either
  says nothing about film-script framing or look-alike letters.
