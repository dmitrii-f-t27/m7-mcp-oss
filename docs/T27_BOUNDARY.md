> Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).

# t27 boundary: what moved, what stays in TypeScript, how it is checked

Some decision rules of this version are written in t27 (`specs/*.t27`), compiled to C by `t27c`, tested natively, and built into one WebAssembly file, `wasm/m7_rules.wasm`. The server loads that file and calls it through thin TypeScript facades in `src/rules/`. This page says which rules moved, which code stays native and why, how the share in the README is measured, where the new rules behave differently from the old TypeScript, and what the checks cannot prove.

The share is small. `README.md` gives the number and the commit it was measured at. It counts code shapes, not importance.

## 1. Spec, facade, callers

| Spec | Lines | Functions | Facade | Callers |
|---|---|---|---|---|
| `specs/bytes_rules.t27` | 60 | 3 | used by `path_rules` | none of its own |
| `specs/path_tables.t27` | 84 | 4 | used by `path_rules` | none of its own. Written by `specs/tables/path_tables.mjs` from the name lists |
| `specs/path_rules.t27` | 382 | 17 | `src/rules/pathRules.ts` | `src/core/security/pathGuard.ts`, `src/core/utils/projectPath.ts` |
| `specs/net_rules.t27` | 139 | 5 | `src/rules/netRules.ts` | `src/visualizer/visualizer-server.ts` |
| `specs/policy_rules.t27` | 284 | 10 | `src/rules/policyRules.ts` | `src/core/utils/safeWrite.ts`, `src/core/tools/initProject.ts`, `src/hive/api/anthropicParams.ts`, `src/core/intelligence/intentClassifier.ts` |
| `specs/mesh_rules.t27` | 513 | 14 | `src/rules/meshRules.ts` | `src/mesh/peerText.ts`, which the mesh tool and Hive use |
| Total | 1,462 | 53 | | `wasm/m7_rules.wasm`: 9,301 bytes |

The order in which the specs are compiled is `specs/ORDER`. The functions the server may call are listed in `specs/exports.txt`; the wasm exports exactly those, `memory` and `_initialize`, and imports nothing.

**How a call goes.** The facade writes the text into a fixed buffer inside the wasm memory, calls the rule with the true length of the text, and reads the answer. Cross-spec calls carry numbers only. A facade decides nothing about the text: its job is to refuse when anything is wrong.

**The loader** (`src/rules/wasm.ts`, with `src/rules/marshal.ts` and `src/rules/generated/constants.ts`) reads `wasm/` next to `dist/`. No environment variable or option changes that path. It checks the SHA-256 of the file against `WASM_SHA256`, checks that the file has no imports, and calls known-answer functions before it serves a call. `src/index.ts` calls `assertRulesLoaded()` at start; a missing or changed wasm stops the server with exit code 1. After a trap the instance is dropped and the next call makes a new one. A failed load stays failed.

**Fail closed.** If the wasm is missing, a call traps, an answer is not one the facade knows, or the input does not fit, each facade gives the refusing value of its rule: no path is inside the project, a verdict refuses, a Host or Origin is not allowed, a file is foreign and is skipped, no temperature is sent, remote classification stays off, a directory is not empty, and peer text is replaced by `[peer text refused: rules unavailable]`. The raw text is never returned.

**Boundary files.** `src/rules/wasm.ts`, `src/rules/marshal.ts` and `src/rules/generated/constants.ts` are counted apart by `scripts/measure-t27-share.mjs`: 3 files, 341 code lines, 45 logic points. Those points are not in the denominator and not in the points now. The other facades count as TypeScript, so logic cannot hide in them.

## 2. What moved

`specs/MOVED.tsv` lists each moved decision: the spec function, the TypeScript symbol it replaced, the commit of the old code, the oracle file and the test file. `node scripts/measure-t27-share.mjs --check-moved` accepts a row only if all four hold:

1. The spec function is exported in `specs/exports.txt`, or called by a function that is.
2. The old symbol is gone from its source file, or holds no logic point.
3. The oracle file exists and names the source file and the commit in its first 30 lines.
4. The test file imports the oracle.

At the time of writing: 36 rows, all confirmed, 112 logic points moved, counted once per symbol.

| Source file | Points moved |
|---|---|
| `src/core/security/pathGuard.ts` | 48 |
| `src/mesh/peerText.ts` | 46 |
| `src/core/utils/safeWrite.ts` | 6 |
| `src/visualizer/visualizer-server.ts` | 4 |
| `src/core/tools/initProject.ts` | 4 |
| `src/core/utils/projectPath.ts` | 3 |
| `src/hive/api/anthropicParams.ts` | 1 |
| `src/core/intelligence/intentClassifier.ts` | 0 (the rule moved; it held no point) |

What moved: path containment, name and control-path verdicts, the project-source choice (path rules); the Host and Origin check of the visualizer (network rules); the managed-marker, write and sync states, the empty-directory rule, the init note, the Opus temperature rule and the remote-classification switch (write-policy rules); the cleaning, cutting and marking of peer text (peer-text rules).

**The oracles.** Each moved rule is tested against the old TypeScript, transpiled at `c41f8ce` by `scripts/make-oracle.mjs` into `tests/oracles/*.mjs`. A differential test runs the oracle and the facade on the same inputs (every edge, every code point of the control ranges, seeded random inputs; the seed is `M7_RULES_SEED`, default 27) and compares the answers. The oracles are never loaded by the server.

**The share.** `node scripts/measure-t27-share.mjs` gives the numbers in the README. The base is the logic points of the TypeScript at `c41f8ce`: 10,823. The share is `(10,823 - points now) / 10,823`. The points now include 48 new ones: 35 are in the four facades (`pathRules.ts` 24, `meshRules.ts` 8, `policyRules.ts` 2, `netRules.ts` 1) and 13 are in the safety-tool fix (SEC-33: `trapCatalog.ts` 11, `inputAnalyzer.ts` 2), which is TypeScript and not part of the move.

## 3. What stays native, and why

| Code | Why it stays |
|---|---|
| `foldUnicode` and `foldName` in `src/core/security/pathGuard.ts` | Unicode normalization, case tables and the ignorable-code-point property come from the platform (ICU in Node). The folded text goes to the rules as bytes. |
| `dataDirRefusal` and its 20,000-entry cap | It is an I/O walk (`lstat`, `readdir`, `realpath`). It calls the moved rule `linkLeavesRoot`, so the verdict is the rule's. |
| `resolveParts`, `parseRootUri`, `isDirectoryEmpty`, `readManagedState` | File system and URI I/O. They read, then call the rules. |
| `isBareHomeDirectory`, `isValidProjectDirectory` | They read the file system and the environment. The rule that uses their answer (`unsafeFallback`) moved. |
| `toText`, `plainNumber`, the `Array.isArray` branch in `untrustedList`, the presence check in `untrustedOr` | JavaScript value conversion (`String()`, `Number.isFinite`) and a missing-value check. They do not look at the content of peer text. |
| The `?:` in `anthropicSampling` | It builds a request object. The rule it asks (`modelTakesTemperature`) moved. |
| The facades in `src/rules/` | They move bytes and refuse. Their own branches are the fail-closed choices and are counted as TypeScript. |
| Everything else | The 54,319 code lines the README names are all the TypeScript in `src/` (tests excluded), the files above and the facades included. Nothing else moved. |

The table lists what the plan kept native. A rule that t27 cannot express stays native, and is added to this table with the reason.

## 4. How the share is classified

`scripts/measure-t27-share.mjs` reads the TypeScript of `src/` (tests excluded) and gives each code line one class; when several apply, the highest wins:

| Class | Lines |
|---|---|
| type | interface, type alias, import, export-from, enum, module, signature, property with no initializer |
| data | a top-level `const` that is a pure literal tree or rooted at `z.`; `inputSchema` and `description` properties. A regex literal is logic, so a tree that holds one is not data |
| logic | first line of `if`, `switch`, `case`, `default`, loops; the condition of `?:`; `&&`, `||`, `??`; other binary operators except `=`, `,` and `+=`; a regex literal; a transform call (`map`, `filter`, `replace` and others) |
| text | a template literal span |
| boundary | every line of a call or `new` rooted at a host API (`fs`, `path`, `process`, `Date`, `JSON`, a logger, a name imported from a host module) or at an SDK, socket or database receiver |
| glue | everything else |

A code line is a line with a token other than `} ) ] ; ,`. Comments and blank lines are not code.

A **logic point** is one non-guard `if`, `?:`, `case` or loop, one `&&`, `||` or `??`, one regex literal, or one transform call. A guard is an `if` whose condition only tests presence, `typeof`, `err.code` or `instanceof`, alone or joined by `&&` and `||`. Guards are counted apart and are not points. `?:`, `&&`, `||` and `??` are always points: they choose a value, they do not guard a path.

The rules go by names, so they make errors. Boundary is a lower bound, and glue is not free: most of it disappears only when its logic moves. The base points are measured at `c41f8ce` by the same script, so a change of the rules cannot make the share drift. `tests/measureShare.test.mjs` checks the script, `specs/MOVED.tsv`, and that the numbers in the README paragraph are the numbers the script gives.

## 5. Sampled error rate

Sampled error rate: **NOT MEASURED. To be filled from the reviewer's audit.** No number is given here.

How the audit is done: `node scripts/measure-t27-share.mjs --rev c41f8ce --sample N --seed S` prints `N` classified code lines picked at random (seeded). The reviewer judges each line's class by hand; the error rate is the share of lines whose class is wrong.

## 6. Known differences from the old TypeScript

Inside the limits, the new rules give the same answer as the old code on every tested input. The cases below are the only ones where they differ. Each, except the one marked, is pinned by a test under the heading "New behaviour" in the file named in the last column.

**Rules that apply to every facade (the bad-text rule).** A facade writes each text whole into its buffer and passes the true length. A text that does not fit is refused, never cut. A text with a lone surrogate is refused by the path, network and write-policy facades, because `TextEncoder.encodeInto` would write U+FFFD and two different texts could become equal. Peer text is the one exception: a lone surrogate becomes U+FFFD, because the answer is for reading, not for comparing. A number that does not fit its type (a port, a `max`) is refused. If the wasm fails, each facade gives the refusing value listed in section 1.

| Facade | Input | Old code | New code | Test |
|---|---|---|---|---|
| Path | A path over 4,096 bytes (over 16,384 bytes after folding, for a verdict) | No limit | Refused: verdict "too long", containment false, relative part null | `tests/rulesPath.test.mjs` |
| Path | A path with a lone surrogate | Compared UTF-16 code units | Refused | `tests/rulesPath.test.mjs` |
| Network | A port that is not a whole number from 0 to 65,535 | Put into the string and compared | Host and Origin refused, also a request with no Origin header | `tests/rulesNet.test.mjs` |
| Policy | A model name over 256 bytes | A name that is not Opus got a temperature | No temperature | `tests/rulesPolicy.test.mjs` |
| Policy | A directory listing over 65,536 bytes (names, each followed by a NUL byte) | Empty if every name was an ignored one | Not empty | `tests/rulesPolicy.test.mjs` |
| Policy | A model name with a lone surrogate | A name that is not Opus got a temperature | No temperature | `tests/rulesPolicy.test.mjs` |
| Policy | `names` that is not an array | `TypeError` | `false` (not empty) | `tests/rulesPolicy.test.mjs` |
| Policy | `hasManagedMarker` with a plain `Uint8Array` (not a `Buffer`) | Always `false`: `Uint8Array.includes` does not search for text | Finds the marker. The declared type is `string \| Buffer`, so this input is outside the contract | not pinned by a test |
| Peer text | A lone surrogate | Passed through | Becomes U+FFFD; its neighbours stay | `tests/rulesMesh.test.mjs`; `tests/sec-mesh.test.mjs:553-555` was edited to expect it |
| Peer text | A text over 3,145,728 bytes of UTF-8 | No limit | Not cut. The answer is `[peer text refused: over the size limit]` | `tests/rulesMesh.test.mjs` |
| Peer text | The rules fail, or answer something that makes no sense | (the rules were TypeScript) | `[peer text refused: rules unavailable]`, never the raw text | `tests/rulesMesh.test.mjs` |
| Peer text | `max` that is not a whole number from 0 to 2^31-1 (`NaN`, `Infinity`, negative, fraction, not a number) | Compared as a number; `Infinity` meant no cut | Refused: `[peer text refused: rules unavailable]`. No caller in `src/` passes such a value (they pass 150, 200 or 300) | `tests/rulesMesh.test.mjs` |
| Peer text | `withPeerHeader` on a text over the limit, or when the rules fail | The header only when the text held `<<<` | The header always goes first, because the fence cannot be ruled out | `tests/rulesMesh.test.mjs` |
| All | The wasm is missing, changed or broken | (not applicable) | The server does not start. If it fails later, each rule gives its refusing value | `tests/rulesWasm.test.mjs` and each `tests/rules*.test.mjs` |

## 7. Memory and load time

The peer-text rules need a 3 MiB input buffer and a 4.5 MiB output buffer inside the wasm memory. The output buffer is 1.5 times the input plus 16 bytes, because a run of angle brackets gains one space for every second bracket, and the marks add a few bytes. Both buffers are reserved when the module is instantiated.

Measured on one Mac (macOS, Node 24.13.0), in 15 fresh Node processes per case, one process at a time. Median of the 15. "Before" is the commit that added the path, network and write-policy rules (`621381f`); "after" is the commit that added the peer-text rules.

| Measure | Before | After |
|---|---|---|
| `wasm/m7_rules.wasm` | 6,202 bytes | 9,301 bytes |
| Wasm memory (`memory.buffer.byteLength`) | 16,908,288 bytes (258 pages) | 24,772,608 bytes (378 pages) |
| Process memory (RSS) after load, minus RSS at process start | 4.63 MiB | 4.70 MiB |
| Node `external` memory after load | 16.70 MiB | 24.21 MiB |
| Time of `assertRulesLoaded()` after the import | 0.96 ms | 1.12 ms |
| Time to import `dist/rules/wasm.js` | 2.58 ms | 2.59 ms |

The wasm memory grew by 7,864,320 bytes: 7.5 MiB, 120 pages. That is the address space the running server holds on top of the earlier stage. The resident size did not grow at load (0.07 MiB, inside the spread of the runs). That fits pages that stay zero, and unbacked, until a call writes into them. It was measured on this machine only.

The worst case in the tests: `peerLine` on 3,145,728 characters `<`, then `peerBlock` on 1,048,576 three-byte characters. The process grew from 43.5 MiB to 71.5 MiB (+28.0 MiB). The two calls took 14.1 ms and 12.8 ms. Of the 28 MiB, 7.5 MiB are wasm pages the calls wrote (3 MiB of input, 4.5 MiB of output). Those stay resident for the life of the process, because wasm memory does not shrink. The rest is JavaScript strings and buffers, which the garbage collector frees. A normal peer value of a few hundred bytes touches only the first pages of each buffer.

Package size (`npm pack --dry-run`) at the code commit of the peer-text rules, before the documents of the last stage: 918 files, 1,282,505 bytes packed, 5,812,690 bytes unpacked. At `c41f8ce`: 1,195,591 bytes packed, 5,482,034 bytes unpacked. `docs/` is not in the package.

## 8. Not provable without the toolchain: a hand-edited manifest

`specs/MANIFEST.sha256` lists the SHA-256 of the specs, the generated headers, the build script, `wasm/m7_rules.wasm` and `src/rules/generated/constants.ts`. `npm test` checks it (`scripts/check-rules-manifest.mjs`), and the loader checks the wasm against `WASM_SHA256` in `constants.ts`.

A person who edits a spec or the wasm, and then rewrites the manifest and `WASM_SHA256` to match, passes both checks without `t27c`. The manifest and the constant are plain text. Only `specs/generate.sh --check` finds it: it regenerates every file from the specs with the pinned compilers into a temporary folder with a cold Zig cache, and compares each file with the tree. It needs `T27C`, `ZIG` and `CC`, so `npm test` cannot run it.

What `npm test` does catch: a wasm whose answers differ from the old TypeScript on the inputs the differential tests use, and a wasm that fails its known-answer calls.

## 9. Building and checking

`npm run build` and `npm test` need no t27 tool. Only the specs do.

```bash
T27C=<path to t27c> ZIG=<path to zig> CC=clang specs/generate.sh          # generate, test natively, build the wasm
T27C=<path to t27c> ZIG=<path to zig> CC=clang specs/generate.sh --check  # compare with the tree; changes nothing
```

`specs/T27C_PIN` names the compilers the output was made with: t27c 0.5.1 at commit `579bc55aa`, and Zig 0.15.2. `generate.sh` stops if the compilers it is given report anything else. It lints the specs (`specs/lint.mjs`), runs each spec natively at `-O2` and under the address and undefined-behaviour sanitizers, checks the test count against the specs, builds the wasm, checks its imports and exports, and writes the constants and the manifest.

`t27c` and Zig are not part of this repository and are not changed by it. Their licences are in `NOTICE`.
