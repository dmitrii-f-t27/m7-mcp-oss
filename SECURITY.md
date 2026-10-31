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
