#!/usr/bin/env bash
# Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
# Generates C from the t27 specs, tests it, builds wasm/m7_rules.wasm and writes the files that depend on it.
#
#   T27C=<t27c> ZIG=<zig> CC=<clang> specs/generate.sh            generate in place
#   T27C=<t27c> ZIG=<zig> CC=<clang> specs/generate.sh --check    generate into a temporary folder with a cold
#                                                                 zig cache and compare every file with the tree
#
# Needs T27C, ZIG and CC (exit 2 if one is not set). CC must be clang: the native tests use -Wshorten-64-to-32.
# `npm run build` and `npm test` do not need any of them; only this script does.
#
# Steps (any failure stops the script with exit 1):
#   1. node specs/lint.mjs
#   2. the compilers match specs/T27C_PIN; t27c parse-complete and check-calls are clean; t27c check has no warning
#   3. t27c gen-c into specs/generated/<spec>.h with the notice line first
#   4. per spec, in the order of specs/ORDER, with the earlier headers first and T27_TEST_MAIN only before the
#      spec under test: a native run at -O2 and a run with address and undefined-behaviour sanitizers; the test
#      count must equal `grep -c '^test '` of the spec
#   5. zig cc builds wasm/m7_rules.wasm from specs/wasm/m7_rules_wasm.c (all headers in one translation unit)
#   6. the wasm has no imports and exactly the exports of specs/exports.txt, memory and _initialize
#   7. src/rules/generated/constants.ts (the #define numbers and WASM_SHA256) and specs/MANIFEST.sha256
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
NOTICE='// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).'

fail() { echo "generate.sh: $*" >&2; exit 1; }

mode=build
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  *) echo "usage: specs/generate.sh [--check]" >&2; exit 2 ;;
esac
for v in T27C ZIG CC; do
  if [ -z "${!v:-}" ]; then echo "generate.sh: $v is not set (needs T27C, ZIG and CC)" >&2; exit 2; fi
done
[ -x "$T27C" ] || { echo "generate.sh: T27C is not an executable file: $T27C" >&2; exit 2; }
[ -x "$ZIG" ] || { echo "generate.sh: ZIG is not an executable file: $ZIG" >&2; exit 2; }
command -v "$CC" >/dev/null 2>&1 || { echo "generate.sh: CC not found: $CC" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "generate.sh: node not found" >&2; exit 2; }

BUILD="$(mktemp -d "${TMPDIR:-/tmp}/m7-rules-build.XXXXXX")"
ROOT="$REPO"
if [ "$mode" = check ]; then ROOT="$(mktemp -d "${TMPDIR:-/tmp}/m7-rules-check.XXXXXX")"; fi
cleanup() {
  rm -rf "$BUILD"
  if [ "$mode" = check ] && [ "$ROOT" != "$REPO" ]; then rm -rf "$ROOT"; fi
}
trap cleanup EXIT

if [ "$mode" = check ]; then
  # Cold zig cache, and a copy of the inputs only: every output is made again.
  export ZIG_GLOBAL_CACHE_DIR="$ROOT/.zig-global" ZIG_LOCAL_CACHE_DIR="$ROOT/.zig-local"
  mkdir -p "$ROOT/specs/wasm" "$ROOT/specs/generated" "$ROOT/wasm" "$ROOT/src/rules/generated"
  cp specs/*.t27 specs/ORDER specs/T27C_PIN specs/exports.txt specs/lint.mjs specs/generate.sh "$ROOT/specs/"
  cp specs/wasm/*.c "$ROOT/specs/wasm/"
  if [ -d specs/tables ]; then cp -R specs/tables "$ROOT/specs/tables"; fi
else
  # Without these zig would write its cache next to the sources.
  export ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-$BUILD/zig-global}" ZIG_LOCAL_CACHE_DIR="${ZIG_LOCAL_CACHE_DIR:-$BUILD/zig-local}"
  mkdir -p specs/generated wasm src/rules/generated
fi
cd "$ROOT"

names_of() { awk '{ sub(/#.*/, ""); for (i = 1; i <= NF; i++) print $i }' "$1"; }

# ---- 1. lint
node specs/lint.mjs "$ROOT" || fail "lint failed"

# ---- 2. compilers, parse, calls, check
pin="$(awk '{ sub(/#.*/, "") } NF { print; exit }' specs/T27C_PIN)"
set -- $pin
[ "$#" -eq 3 ] || fail "specs/T27C_PIN must hold: <commit> t27c-<version> zig-<version>"
want_t27c="t27c ${2#t27c-}"
want_zig="${3#zig-}"
have_t27c="$("$T27C" --version 2>&1 | head -n 1)"
have_zig="$("$ZIG" version 2>&1 | head -n 1)"
[ "$have_t27c" = "$want_t27c" ] || fail "t27c reports \"$have_t27c\", specs/T27C_PIN pins \"$want_t27c\" (commit $1; the commit itself is checked in the final checks)"
[ "$have_zig" = "$want_zig" ] || fail "zig reports \"$have_zig\", specs/T27C_PIN pins \"$want_zig\""

order=()
while IFS= read -r n; do order+=("$n"); done < <(names_of specs/ORDER)
[ "${#order[@]}" -gt 0 ] || fail "specs/ORDER names no spec"
for s in "${order[@]}"; do [ -f "specs/$s.t27" ] || fail "specs/$s.t27 is named in ORDER but missing"; done

out="$("$T27C" parse-complete --specs-dir specs 2>&1)" || { echo "$out" >&2; fail "t27c parse-complete failed"; }
echo "$out" | awk -v want="${#order[@]}" '
  /specs scanned/ { s = $3 } /parse and consume all/ { c = $5 } /parse but TRUNCATE/ { t = $4 }
  /parse but DISCARD/ { d = $4 } /do not parse/ { n = $4 }
  END { if (s != want || c != want || t != 0 || d != 0 || n != 0) { print "parse-complete: scanned=" s " consume=" c " truncate=" t " discard=" d " noparse=" n " (want " want " specs, all consumed)" > "/dev/stderr"; exit 1 } }
' || { echo "$out" >&2; fail "t27c parse-complete is not clean"; }
out="$("$T27C" check-calls --specs-dir specs 2>&1)" || { echo "$out" >&2; fail "t27c check-calls failed"; }
echo "$out" | awk '/TOTAL/ { if ($2 != 0) exit 1; ok = 1 } END { if (!ok) exit 1 }' || { echo "$out" >&2; fail "t27c check-calls reports mismatches"; }
for s in "${order[@]}"; do
  out="$("$T27C" check "specs/$s.t27" 2>&1)" || { echo "$out" >&2; fail "t27c check failed on $s"; }
  echo "$out" | grep -q 'Typecheck OK (0 errors, 0 warnings)' || { echo "$out" >&2; fail "t27c check on $s is not 0 errors and 0 warnings"; }
done

# ---- 3. gen-c
rm -f specs/generated/*.h
for s in "${order[@]}"; do
  "$T27C" gen-c "specs/$s.t27" > "$BUILD/$s.raw.h" 2> "$BUILD/$s.gen.err" || { cat "$BUILD/$s.gen.err" >&2; fail "t27c gen-c failed on $s"; }
  [ ! -s "$BUILD/$s.gen.err" ] || { cat "$BUILD/$s.gen.err" >&2; fail "t27c gen-c wrote to stderr on $s"; }
  { printf '%s\n' "$NOTICE"; cat "$BUILD/$s.raw.h"; } > "specs/generated/$s.h"
done

# ---- 4. native runs
NATIVE_WARN=(-Wall -Wshorten-64-to-32 -Wno-parentheses-equality -Werror)
run_native() { # <label> <spec> <index> <compiler flags...>
  local label="$1" s="$2" idx="$3"; shift 3
  local src="$BUILD/test_${label}_$s.c" bin="$BUILD/test_${label}_$s" j
  { j=0; while [ "$j" -lt "$idx" ]; do printf '#include "%s.h"\n' "${order[$j]}"; j=$((j + 1)); done
    printf '#define T27_TEST_MAIN\n#include "%s.h"\n' "$s"; } > "$src"
  "$CC" -std=c11 "$@" -ffp-contract=off "${NATIVE_WARN[@]}" -I specs/generated "$src" -o "$bin" -lm 2> "$BUILD/cc.err" || { cat "$BUILD/cc.err" >&2; fail "native build ($label) failed on $s"; }
  local result count want
  result="$("$bin" 2>&1)" || { echo "$result" >&2; fail "native run ($label) failed on $s"; }
  count="$(echo "$result" | sed -n 's/^All \([0-9][0-9]*\) tests passed\.$/\1/p')"
  want="$(grep -c '^test ' "specs/$s.t27" || true)"
  [ -n "$count" ] && [ "$count" = "$want" ] || { echo "$result" >&2; fail "native run ($label) on $s ran ${count:-no} tests, the spec has $want"; }
  echo "generate.sh: $s $label: $count tests passed"
}
idx=0
for s in "${order[@]}"; do
  run_native O2 "$s" "$idx" -O2 -fwrapv
  run_native sanitize "$s" "$idx" -O1 -g -fwrapv -fsanitize=address,undefined -fno-sanitize-recover=all
  idx=$((idx + 1))
done

# ---- 5. wasm
for s in "${order[@]}"; do
  grep -q "^#include \"$s.h\"" specs/wasm/m7_rules_wasm.c || fail "specs/wasm/m7_rules_wasm.c does not include $s.h"
done
exports=()
while IFS= read -r n; do exports+=("$n"); done < <(names_of specs/exports.txt)
[ "${#exports[@]}" -gt 0 ] || fail "specs/exports.txt names no export"
export_flags=()
for e in "${exports[@]}"; do export_flags+=("-Wl,--export=$e"); done
mkdir -p wasm
"$ZIG" cc --target=wasm32-wasi -mexec-model=reactor -O2 -DNDEBUG -fwrapv -ffp-contract=off -std=c11 \
  -Wno-parentheses-equality -s -I specs/generated -Wl,--no-entry -Wl,--gc-sections \
  "${export_flags[@]}" specs/wasm/m7_rules_wasm.c -o wasm/m7_rules.wasm 2> "$BUILD/zig.err" || { cat "$BUILD/zig.err" >&2; fail "zig cc failed"; }
[ ! -s "$BUILD/zig.err" ] || { cat "$BUILD/zig.err" >&2; fail "zig cc wrote to stderr"; }
chmod 644 wasm/m7_rules.wasm

# ---- 6. imports and exports
node --input-type=module -e '
import { readFileSync } from "node:fs";
const [, file, ...want] = process.argv;
const mod = new WebAssembly.Module(readFileSync(file));
const imports = WebAssembly.Module.imports(mod);
if (imports.length !== 0) { console.error("the wasm has imports: " + JSON.stringify(imports)); process.exit(1); }
const have = WebAssembly.Module.exports(mod).map(e => e.name).sort();
const expect = [...want, "memory", "_initialize"].sort();
if (have.join(" ") !== expect.join(" ")) { console.error("exports differ.\n  wasm:    " + have.join(" ") + "\n  wanted:  " + expect.join(" ")); process.exit(1); }
console.log("generate.sh: wasm has no imports and " + have.length + " exports (" + want.length + " from exports.txt, memory, _initialize)");
' wasm/m7_rules.wasm "${exports[@]}" || fail "the wasm imports or exports are wrong"

# ---- 7. constants.ts and the manifest
node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [, notice, ...order] = process.argv;
const out = [notice, "// Generated by specs/generate.sh from the #define numbers of specs/generated/*.h and from wasm/m7_rules.wasm. Do not edit.", ""];
const seen = new Map();
for (const spec of order) {
  const text = readFileSync("specs/generated/" + spec + ".h", "utf8");
  for (const m of text.matchAll(/^#define ([A-Z][A-Z0-9_]*) (-?\d+)$/gm)) {
    if (seen.has(m[1])) { console.error(m[1] + " is defined in " + seen.get(m[1]) + " and " + spec); process.exit(1); }
    seen.set(m[1], spec);
    out.push("export const " + m[1] + " = " + m[2] + ";");
  }
}
const sha = createHash("sha256").update(readFileSync("wasm/m7_rules.wasm")).digest("hex");
out.push("export const WASM_SHA256 = \"" + sha + "\";", "");
writeFileSync("src/rules/generated/constants.ts", out.join("\n"));
' "$NOTICE" "${order[@]}" || fail "writing constants.ts failed"
node "$REPO/scripts/check-rules-manifest.mjs" --write "$ROOT" || fail "writing the manifest failed"

size="$(wc -c < wasm/m7_rules.wasm | tr -d ' ')"
echo "generate.sh: ${#order[@]} spec(s), wasm $size bytes, sha256 $(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync("wasm/m7_rules.wasm")).digest("hex"))')"

# ---- --check: compare with the tree
if [ "$mode" = check ]; then
  bad=0
  outputs=(wasm/m7_rules.wasm src/rules/generated/constants.ts specs/MANIFEST.sha256)
  for s in "${order[@]}"; do outputs+=("specs/generated/$s.h"); done
  for f in "${outputs[@]}"; do
    if [ ! -f "$REPO/$f" ]; then echo "generate.sh --check: $f is missing from the tree" >&2; bad=1
    elif ! cmp -s "$f" "$REPO/$f"; then echo "generate.sh --check: $f differs from the tree" >&2; bad=1; fi
  done
  for f in "$REPO"/specs/generated/*; do
    [ -e "$f" ] || continue
    [ -f "$ROOT/specs/generated/$(basename "$f")" ] || { echo "generate.sh --check: specs/generated/$(basename "$f") is in the tree but not generated" >&2; bad=1; }
  done
  [ "$bad" -eq 0 ] || fail "--check found differences: run specs/generate.sh and commit the result"
  echo "generate.sh --check: clean (${#outputs[@]} files identical)"
fi
