#!/usr/bin/env bash
# Modified by Dmitrii Fedorov, 2026: changed from the original M7 MCP (see NOTICE).
# Runs every tests/*.test.mjs, tests/reliability/*.test.mjs and the compiled safety
# tests dist/core/safety/__tests__/*.test.js in isolation
# with a per-file timeout, then fails if any test wrote into the repository.
# Usage: scripts/run-tests.sh [timeout_seconds]
#
# Notes:
# - Tests import from dist/, so run `npm run build` first.
# - CURSOR_WORKSPACE is pinned to the repo root so project-path resolution
#   does not wander off to another workspace on the machine. Tests that write
#   state must bind their own temp project (CURSOR_WORKSPACE outranks
#   M7_PROJECT_PATH); the pollution check below enforces that.
# - The two API keys and the two base URLs are set below whatever the shell holds,
#   so a test run never uses a real key and never reaches a real API. A test that
#   needs a fake provider sets its own base URL for its child process.
# - --test-force-exit: some modules keep timers/watchers alive after the
#   tests finish; without it the process would hang.
set -u
cd "$(dirname "$0")/.."

TIMEOUT="${1:-120}"
export CURSOR_WORKSPACE="${CURSOR_WORKSPACE:-$PWD}"
export OPENAI_API_KEY="sk-test-placeholder"
export ANTHROPIC_API_KEY="sk-ant-test-placeholder"
export OPENAI_BASE_URL="http://127.0.0.1:9/v1"
export ANTHROPIC_BASE_URL="http://127.0.0.1:9"

pass=0; fail=0; failed=()
marker="$(mktemp "${TMPDIR:-/tmp}/m7-test-start.XXXXXX")"

for f in tests/*.test.mjs tests/reliability/*.test.mjs dist/core/safety/__tests__/*.test.js; do
  out="/tmp/m7-test-out.$$"
  if perl -e 'alarm shift; exec @ARGV' "$TIMEOUT" node --test --test-force-exit "$f" >"$out" 2>&1; then
    echo "OK      $f"; pass=$((pass+1))
  else
    code=$?
    if [ "$code" -eq 142 ]; then echo "TIMEOUT $f"; else echo "FAIL    $f (exit $code)"; fi
    grep -E '✖|not ok|Error' "$out" | head -n 15 | sed 's/^/        /'
    fail=$((fail+1)); failed+=("$f")
  fi
  rm -f "$out"
done

touched="$(find . \( -path ./node_modules -o -path ./dist -o -path ./.git \) -prune -o -type f -newer "$marker" -print)"
rm -f "$marker"
if [ -n "$touched" ]; then
  echo "FAIL    repository pollution: tests wrote files into the repo"
  echo "$touched" | head -n 20 | sed 's/^/        /'
  fail=$((fail+1)); failed+=("repository pollution check")
fi

echo
echo "passed: $pass  failed: $fail"
if [ "$fail" -gt 0 ]; then printf '  %s\n' "${failed[@]}"; exit 1; fi
