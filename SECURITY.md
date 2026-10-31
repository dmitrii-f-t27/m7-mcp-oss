# Security

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
  models for Hive).
- **On the first `mcp_m7_analyze_task` call of a server process:** a model list
  request to OpenAI and one to Anthropic (the time and models header). The
  result is kept in memory for 24 hours.

### Other destinations you control

- **Hive** (`mcp_m7_hive_coordinator`) calls OpenAI and Anthropic with the task
  you give it. The switch above does not cover Hive.
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
  (`src/mesh/relay/server.ts:88-90`). `/health` needs no token and returns the
  number of workstations and the uptime. Every other route needs the token.

## The installer (`install.sh`)

- **Keys stay in `.env`.** The installer writes the keys you type to the `.env`
  file in the install directory and sets its mode to 600 (`install.sh:180`,
  `:194`, `:227`). On Windows `chmod` does nothing, and `install.sh` needs bash.
- **`~/.cursor/mcp.json` is merged, not replaced.** The installer calls
  `scripts/merge-cursor-config.mjs` (`install.sh:275`). The script adds or
  replaces only `mcpServers.m7`. Every other server and every other top-level
  key stays. The installer still copies the file to
  `mcp.json.backup.<time>` first (`install.sh:268`).
- **No key goes into `mcp.json`.** The `m7` entry holds `command`, `args` and
  `cwd` only (`scripts/merge-cursor-config.mjs:30-36`). The server reads its
  keys from the `.env` file (see the `.env` section above).
- **A file the script cannot merge into is left alone.** That means a file that
  is not valid JSON (an empty file too), whose top level is not an object, or
  whose `mcpServers` is not an object. The script writes nothing, prints the
  reason to stderr and exits with code 2. The installer then reports that the
  Cursor configuration was not changed and goes on (`install.sh:275-281`).
- **If you used the old installer,** your `mcp.json` can hold your API keys in
  plain text under `mcpServers.m7.env`, and so can every `mcp.json.backup.*`
  file next to it. Updating the `m7` entry with the new installer removes the
  `env` block from `mcp.json`. It does not touch the backup files. Delete them
  yourself, and rotate a key if the file was ever shared.
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

`file:line` refers to the tree that contains this file, after stage 2.8 of the
`clean-secure-t27` branch. Line numbers move when code changes. Search for the
function name if a line is off.

- FIXED: the code no longer does the thing. Each test file named in the last
  column had tests that failed on the old code. Some tests in those files pass
  on both versions, because they guard behaviour that must stay the same. Where
  a test cannot show the fix, the column says so.
- CHANGED: the behaviour changed, and the effect on the outside is unverified.
- OPEN: not fixed in this branch.

| ID | Sev | Risk | Status | Where | Test |
|---|---|---|---|---|---|
| SEC-1 | HIGH | Shell command built from task text | FIXED; already so at the base commit `0ace0ab`, unchanged here. Every child process in `src` is started with an argument list (`git`, `grep`, `rg`); a text search finds no `shell: true` and no `execSync(` | `src/core/architecture/architecture-context-analyzer.ts:30-43` (argv `--fixed-strings -e <keyword> --`), `:145-147` (`execFileAsync`, no shell); `src/hive/context/fileSearcher.ts:9`, `:48`; `src/core/tools/projectIndex/projectScanner.ts:138`; `src/telemetry/gitCapture.ts:53` | none added |
| SEC-2 | HIGH | `analyze_task` and `init_project` overwrite project files | FIXED (stage 2.1), with the exceptions below | `src/core/utils/safeWrite.ts:14`, `:64-72` (`wx`), `:123`, `:133`; `src/core/tools/initProject.ts:48`, `:225`, `:238`, `:255`, `:297`; `src/core/tools/analyzeTask.ts:264-266`, `:914`; `src/core/tools/unified/memoryTool.ts:464`, `:501`, `:551` | `tests/sec-init-overwrite.test.mjs` |
| SEC-3 | MED | Task text sent to OpenAI, twice per `analyze_task`, not documented | FIXED (stage 2.3): local by default, opt-in | `src/core/intelligence/intentClassifier.ts:220`, `:232`, `:257`, `:278`, `:293-300`, `:307`, `:309`; callers `src/core/tools/analyzeTask.ts:300`, `src/core/router.ts:93` | `tests/sec-classifier.test.mjs` |
| SEC-4 | MED | `analyze_task` starts Docker | FIXED; already so at the base commit `0ace0ab` | `src` starts no Docker process (the only child processes are `git`, `grep` and `rg`, see SEC-1). The health check is one HTTP GET, `src/core/health/healthCheck.ts:54`. `src/core/warmup/warmupManager.ts:626` and `src/core/tools/projectIndex/projectScanner.ts:579` only test that a file exists, and `src/core/tools/projectIndex/projectScanner.ts:580` adds the text `docker-compose up` to a generated quick-start list without running it | none added |
| SEC-5 | MED | The Cursor activity guess beat `M7_PROJECT_PATH` | FIXED (stage 2.4) | `src/core/utils/projectPath.ts:8-22` (order), `:250-253`, `:281-287` (`selectProjectSource`), `:484-489` (`ensureProjectPathResolved`), `:553` (diagnostics) | `tests/sec-project-path.test.mjs` |
| SEC-6 | MED | Visualizer on all interfaces, no auth, `CORS *` | FIXED (stage 2.5); no token, see limits | `src/visualizer/visualizer-server.ts:36`, `:44`, `:56`, `:161`, `:177`, `:224-235`, `:767`; `src/core/tools/v3/visualizer-tool.ts:168-176` | `tests/sec-visualizer.test.mjs` |
| SEC-7 | MED | Mesh writes peer files and injects peer messages | FIXED (stage 2.2), with limits | `src/core/security/pathGuard.ts:93`, `:102`, `:202`, `:216`; `src/mesh/tools/meshTool.ts:124-149`, `:525`, `:669`, `:694`, `:701-705`; `src/mesh/peerText.ts:23`, `:87`, `:92`; `src/core/tools/projectIndex/projectIndexTool.ts:114-119`; `src/core/tools/createStructure.ts:188-191`, `:201`; `src/core/orchestrator/groundingGate.ts:66-72` | `tests/sec-mesh.test.mjs`, `tests/sec-write-paths.test.mjs` |
| SEC-8 | MED | A `.env` in the working directory redirected outgoing requests | FIXED (stage 2.6) | `src/core/utils/loadEnv.ts:13-15`, `:22-27`; `src/index.ts:5` | `tests/sec-env.test.mjs` |
| SEC-9 | MED | Hive sends `temperature` to Opus models, said to be rejected | CHANGED; the rejection is **unverified** | `src/hive/api/anthropicParams.ts:15`, `:24`; call sites `src/hive/intelligence/hiveArchitect.ts:76`, `:231`, `src/hive/orchestrator/dynamicOrchestrator.ts:437`, `:524`, `src/hive/api/apiManager.ts:408`, `src/hive/planner/plannerAgent.ts:72`, `src/hive/debate/debateEngine.ts:505` | `tests/sec-anthropic-temperature.test.mjs` |
| SEC-10 | LOW | Key text in logs; the installer replaced `~/.cursor/mcp.json` and wrote keys into it | FIXED (stage 2.8) | logs: `src/index.ts:241-242` and `src/hive/tools/hiveCoordinator.ts:198-199` print `set` / `present`; installer: see "The installer" above, `scripts/merge-cursor-config.mjs:44-65`, `install.sh:180-227`, `:268-281` | `tests/sec-low.test.mjs` (merge script only) |
| SEC-11 | LOW | Hive has no global spend limit and no cancel | OPEN, LOW; no fix in this branch | a cap per debate only: `src/hive/debate/debateEngine.ts:78-80`, `:97-99`; the Hive tool starts the run with no budget and no abort: `src/hive/tools/hiveCoordinator.ts:215`, `:220` | none |

### Other spots

| ID | Sev | Risk | Status | Where | Test |
|---|---|---|---|---|---|
| SEC-12 | LOW | Relay listened on every interface; bearer compared with `===` | FIXED (stage 2.8) | `src/mesh/relay/server.ts:24`, `:61-76`, `:263-264` | `tests/sec-low.test.mjs` (the compare is a static check) |
| SEC-13 | LOW | Relay answers with `Access-Control-Allow-Origin: *` | OPEN, LOW; found in stage 2.8 | `src/mesh/relay/server.ts:88-90` | none |
| SEC-14 | MED | `project_index` `output_path` written to any path | FIXED (stage 2.2): the tool contains the path; the generator still writes where it is told | `src/core/tools/projectIndex/projectIndexTool.ts:114-119`; `src/core/tools/projectIndex/indexGenerator.ts:70-71` | `tests/sec-write-paths.test.mjs` |
| SEC-15 | MED | A `path:` premise in the grounding gate was checked by string, not by real path | FIXED (stage 2.2) | `src/core/orchestrator/groundingGate.ts:66-72` | `tests/sec-write-paths.test.mjs` |
| SEC-16 | LOW | An explicit `project_path` is accepted if the directory exists, and it sticks for the session | OPEN, by design | `src/core/utils/projectPath.ts:64-74`, `:390-394` | none |
| SEC-17 | LOW | `logger.ts` redacts nothing; `sanitizer.ts` redacts only before a telemetry upload | OPEN, LOW; no fix in this branch. The logger writes only when `M7_DEBUG=true` | `src/core/utils/logger.ts:30`, `:48`, `:56`; `src/telemetry/sanitizer.ts:88`; used at `src/telemetry/gitCapture.ts:136` | none |
| SEC-18 | LOW | Debug log held the first 50 characters of the task text | FIXED (stage 2.3): the log holds the length only | `src/core/intelligence/intentClassifier.ts:307` | `tests/sec-classifier.test.mjs` |
| SEC-19 | ? | Not traced: the `path` input of `style_guardian`, `hub_path` of the knowledge hub config, `trackChange` in the scope guard. `routeToReferenceFile` was traced: it returns fixed file names | OPEN, unknown | `src/core/tools/v3/style-guardian-tool.ts:29`; `src/core/tools/knowledgeHub/types.ts:356`; `src/core/guards/scopeGuard.ts:104`; `src/core/tools/unified/memoryTool.ts:276-302` | none |
| SEC-20 | MED | `knowledge_hub` `init` and `migrate` move your `INDEX.md` and similar root files into the hub; `rename` replaces an existing target | OPEN; runs only on an explicit hub action, not from `analyze_task` or `init_project`; a backup of the files goes to `.m7/backups/knowledge-hub/` first | `src/core/tools/knowledgeHub/core/MigrationManager.ts:23`, `:77-81`, `:132`; `src/core/tools/knowledgeHub/utils/fileUtils.ts:132`; `src/core/tools/knowledgeHub/core/KnowledgeHub.ts:131-136`; `src/core/tools/knowledgeHub/knowledgeHubTool.ts:135` (action `init`), `:202` (action `migrate`) | none |
| SEC-21 | MED | At server start the systems (memory, journal, schema, scope guard) are built on the start-up path, usually the install directory, while `M7_PROJECT_PATH` is set and MCP Roots are unfinished. They move only when the path-change callback fires. `contracts.ts` can write `PROJECT_SCHEMA.yaml` into the stale root | OPEN; to be reviewed | `src/index.ts:168`, `:191-198`, `:205`; `src/core/tools/critical/contracts.ts:383` | none |
| SEC-22 | LOW | `validatePath` in the knowledge hub uses a bare prefix check | OPEN, latent: nothing in `src` or `tests` calls it | `src/core/tools/knowledgeHub/utils/fileUtils.ts:166-175` | none |
| SEC-23 | LOW | `create_structure`: a `task_id` such as `../../x` stays inside the project but can put templates outside `docs/` | OPEN, LOW | `src/core/tools/createStructure.ts:73`, `:218-220` (name), `:188-191` (containment) | `tests/sec-write-paths.test.mjs` (containment only) |
| SEC-24 | LOW | `push-file` can send control paths such as `.git/config` (only `pull-file` refuses them) | OPEN, by design | `src/core/security/pathGuard.ts:93`, `:102` | none |
| SEC-25 | LOW | Mesh error text is flattened to one line but not fenced | OPEN, LOW | `src/mesh/tools/meshTool.ts:831` | none |

### Details and limits per item

- **SEC-2 exceptions.** (a) `.gitignore` gets one `.m7/` line added; the file is
  read, extended and written back
  (`src/core/tools/initProject.ts:899-911`), and the lines you had stay. (b) `CYCLE_REGISTRY.md` is rewritten with the new row when you
  register a cycle summary, with or without the M7 marker
  (`src/core/orchestrator/cycleOrchestrator.ts:1582`, `:1632`). Your content is
  kept, and the only caller is the `mcp_m7_cycle` summary action
  (`src/core/tools/cycleTool.ts:55`). (c) `mesh pull-file` with `overwrite=true`
  replaces a file (SEC-7). (d) SEC-20.
- **SEC-2 marker rule.** M7 changes an existing file later only if it carries
  `<!-- m7-managed -->` in its first 4096 bytes. A project that M7 set up
  before this change has no marker, so the memory bridge no longer appends to
  its `CODING_STANDARDS.md`, `CYCLE_REGISTRY.md` or `MASTER_REFERENCE.md`, and
  the answer says "not synced". This is accepted. Adding the marker line by hand
  turns the bridge on again for that file. Be careful with
  `memory-bank/activeContext.md`: with the marker, M7 replaces the whole file
  on each `analyze_task`.
- **SEC-3 requests that carry no task text.** See "What leaves the machine".
  Model discovery runs when the server starts and uses both keys: one model
  list request to OpenAI (`src/hive/api/modelDiscovery.ts:100`) and one 1-token
  `Hi` message to Anthropic for each of five model names
  (`src/hive/api/modelDiscovery.ts:137-151`). `src/index.ts:244` creates the
  API manager, and its constructor starts the discovery
  (`src/hive/api/apiManager.ts:130`). The result is kept for 24 hours
  (`src/hive/api/modelDiscovery.ts:92`). The server refuses to start without
  both keys (`src/index.ts:234-237`). The model lists for the time-and-models
  header are fetched at the first `analyze_task` call
  (`src/core/tools/analyzeTask.ts:221-222`, `src/context/context-provider.ts:143`,
  `:177`) and kept for 24 hours (`src/context/types.ts:79`). A probe against a
  stub server in stage 2.3 saw 6 requests at start, 2 more at the first
  `analyze_task` and none at the second. No live call was made.
- **SEC-6 limit.** The visualizer has no token. Another user account on the
  same machine can connect to `127.0.0.1` while it runs.
- **SEC-7 limits.** Marking peer text as untrusted lowers the risk of prompt
  injection. It does not prevent it. The check that a path stays inside the
  project and the write that follows are two steps: a symlink swapped in
  between is not caught for `mesh pull-file overwrite=true`
  (`src/mesh/tools/meshTool.ts:701-702` uses a plain write; the default path
  uses `wx`). `mesh push-file` refuses
  secret files (`.env`, `.npmrc`, `*.pem`, `id_rsa` and so on), and `pull-file`
  refuses those and the control paths `.git`, `.cursor`, `.cursorrules`,
  `.vscode`, `.claude`, `.m7`, `.husky`, `.github`.
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

## Dependencies: `npm audit`

`npm audit` lists **6 entries** (1 low, 3 moderate, 2 high, 0 critical). This is
a point-in-time result from the advisory database. Run `npm audit` again, the
answer changes as advisories are added. The advisory floors that could be
raised without a major version change were raised in stage 1
(`@modelcontextprotocol/sdk`, `ws`, `js-yaml`, `yaml`). The six entries remain
because their fixes need a major version change or a downgrade. No `--force`
was used. Whether each is reachable was decided **by reading the code**. Nothing
was run to try to trigger them.

| Package (installed) | Sev | Advisory | Used in `src`? | Why it is not fixed, and reachability |
|---|---|---|---|---|
| `zod` 3.25.76 | high | GHSA-mrhx-c7xc-m3w5: memory exhaustion while validating oversized constrained collections (`<4.6.6`) | Yes: tool input schemas, 39 files import it | There is no 3.x fix. The fix is zod 4, a major change. The relay imports no zod (`src/mesh/relay`). Zod parses the arguments of a tool call, and those come from your local MCP client over stdio (for example `src/mesh/tools/meshTool.ts:732`). Peer data from the relay is not parsed with zod. |
| `openai` 5.23.2 | high | `npm audit` reports it only "via zod" (range `4.55.0 - 5.23.2`) | Yes (`src/core/intelligence/intentClassifier.ts:278`, `src/hive/api/apiManager.ts:115`, others) | The fix is openai 7.x, a major change. The advisory is the zod chain above, not a flaw in the code of `openai` itself. |
| `diff` 7.0.0 | low | GHSA-73rr-hh4g-fpgx: denial of service in `parsePatch` and `applyPatch` (`>=6.0.0 <8.0.3`) | `src/core/tools/critical/impact.ts:7` | `src` imports `diffChars`, `diffLines` and `createTwoFilesPatch` only (`src/core/tools/critical/impact.ts:304`, `:318`, `:438`). It never calls `parsePatch` or `applyPatch`. The fix is diff 9, a major change. |
| `minimatch` 10.2.6 | moderate | GHSA-g3hv-75wg-m249: denial of service through globparts amplification (`<11.0.1`) | Not imported by M7 (`minimatch` is in no file under `src` and not in `package.json`). It comes in through `@ts-morph/common`. | No pattern reaches it. The only M7 code that uses ts-morph is `src/core/tools/knowledgeHub/scanners/TypeScanner.ts`. It adds files one by one with a concrete path (`src/core/tools/knowledgeHub/scanners/TypeScanner.ts:76`, `addSourceFileAtPath`) and calls `project.getSourceFiles()` with no pattern (`src/core/tools/knowledgeHub/scanners/TypeScanner.ts:85`). In the installed `@ts-morph/common` 0.28.1, `minimatch` is called in one place, `matchGlobs` (`dist/ts-morph-common.js:1696`). In the installed `ts-morph` 27.0.2, `matchGlobs` is called only inside `getSourceFiles(globPatterns)` (`dist/ts-morph.js:18881`, `:20908`), and only when a pattern is passed. This is a reading of that code, not a run. How ts-morph reads `include` and `exclude` of the `tsconfig.json` of the scanned project was **not** traced. |
| `@ts-morph/common` 0.28.1 | moderate | via `minimatch` | via `ts-morph` | The audit offers ts-morph 10.0.1, a downgrade across many majors. Not applied. |
| `ts-morph` 27.0.2 | moderate | via `@ts-morph/common` | `src/core/tools/knowledgeHub/scanners/TypeScanner.ts:32` (lazy `import('ts-morph')`) | Same as above. |

## Secret scan: gitleaks

`gitleaks detect --source <repo> --no-banner` scans the git history of this
clone. Before `.gitleaksignore` it reported 2 findings, both in
`src/tsi/patterns/security/auth.yaml`, lines 30 and 32. I read the file. Both
lines sit in a `bad:` code sample of a pattern catalogue (it shows insecure
code on purpose; the `good:` sample follows at line 33). The values are plain
placeholders, and they are not real credentials. They were not tried against
any service. Line 31, the neighbouring `DB_PASSWORD` sample, was not a finding.
`.gitleaksignore` holds the two fingerprints, which contain no secret. They are
tied to commit `72a7640700dbd7cebc0d57eabe8253989af084ba` and to those line
numbers. If the file is edited, the lines move and the findings come back.

After the ignore file, the scan of the history finds no leaks. A second scan
with `--no-git` over the files changed in the stage also finds none. A clean
scan shows that the rules of gitleaks found nothing. It does not show that no
secret exists.

## Known limits

- Prompt injection through peer text, files and model output is reduced, not
  prevented (SEC-7).
- The visualizer and the relay have no per-user identity (SEC-6, SEC-12).
- Remote classification, when switched on, sends the task text to OpenAI. Hive
  always sends the task text to OpenAI and Anthropic when you use it.
- `.env` in the install directory, the process environment and the MCP client
  config are trusted input (SEC-8).
- An explicit `project_path` is followed if the directory exists (SEC-16).
- The logger redacts nothing and is off unless `M7_DEBUG=true` (SEC-17).
- Opus models run at the API default temperature (SEC-9).
- One test in `tests/deepScanAcceptance.test.mjs` (the one named "existing
  file without fog entry") failed once in a full run and then passed. The
  cause is unknown. It is not known to be a security issue.

## What is not verified

- **No live model call.** No test here calls OpenAI or Anthropic. Stub servers
  on `127.0.0.1` stand in. That is why the claim that Opus models reject
  `temperature` (SEC-9) is unchecked, and why model discovery, retries and
  time-outs are checked against a stub only.
- **No live relay deployment.** The relay ran only on this machine: on
  loopback, and in one probe on `0.0.0.0` reached through this machine's own
  link-local address. It was never run behind TLS, a proxy, a container or a
  cloud host, and never with two machines.
- **Windows was not tested.** The path rules in `pathGuard.ts` have a Windows
  branch (`isInsideWith`, `src/core/security/pathGuard.ts:116`) that runs only
  as a pure function on this machine. Symlink behaviour, `chmod 600`, case rules and `install.sh` (bash)
  were not tried on Windows. Linux was not run either. All runs were on macOS
  with Node 24.
- **Slack and Statsig could not be checked.** This repository holds no Slack
  or Statsig client. A text search finds only a Slack-token pattern in the
  telemetry redaction (`src/telemetry/sanitizer.ts:28-29`) and `slack` as a
  channel name in a sample workflow file that no source file loads
  (`workflows/development/m7-task-workflow.yaml:126`, `:134`, `:142`). Nothing
  outside this repository, such as the upstream project or a hosted service,
  was queried.
- **`install.sh` was not run.** Only the merge script was tested (see above).
- **Token compare timing was not measured** (SEC-12).
- **Reachability of the `npm audit` entries** rests on reading the code
  (section above).
- **Tool surface.** Tool names and input schemas were compared with the 3.22.2
  list. The behaviour behind each tool was not compared one by one.
