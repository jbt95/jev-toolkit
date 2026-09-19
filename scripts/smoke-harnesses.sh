#!/bin/sh
# Cross-harness smoke test: one prompt through every wired harness.
#
# Each harness must answer the SAME quantitative question and leave a fresh
# `call` event under its own harness tag. The prompt names no tool, so a run
# also exercises prompt recall: a harness that answers without calling Jev is
# a finding, not a pass. This is NOT part of `npm test` — it runs real agent
# sessions and spends real tokens on the live TypeSafe API.
#
# Usage:
#   scripts/smoke-harnesses.sh [--only opencode,claude-code,pi,omp] [--keep]
#
# Env:
#   JEV_SMOKE_OPENCODE_MODEL  model for opencode (default opencode-go/deepseek-v4.1-flash)
#   JEV_SMOKE_CLAUDE_TOOL     MCP tool pre-approved for claude (default the plugin name)
#   JEV_SMOKE_TIMEOUT         seconds allowed per harness (default 300)
#   JEV_DATA_DIR              event log directory (default ~/.local/share/jev)

set -eu

only=""
keep=0
for arg in "$@"; do
  case "$arg" in
    --only=*) only="${arg#--only=}" ;;
    --keep) keep=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

log="${JEV_DATA_DIR:-$HOME/.local/share/jev}/events.jsonl"
timeout_s="${JEV_SMOKE_TIMEOUT:-300}"
prompt="Which option is best for a small team's audit log: Postgres versus SQLite? Answer in one line."
opencode_model="${JEV_SMOKE_OPENCODE_MODEL:-opencode-go/deepseek-v4.1-flash}"
claude_tool="${JEV_SMOKE_CLAUDE_TOOL:-mcp__plugin_jev-toolkit_jev__typesafe_ask}"

for tool in jev jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 2; }
done
[ -f "$log" ] || { echo "no event log at $log" >&2; exit 2; }
if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  echo "TYPESAFE_API_KEY is not set; export it before running the smoke test" >&2
  exit 2
fi

root=$(mktemp -d "${TMPDIR:-/tmp}/jev-smoke-harnesses.XXXXXX")
workspace="$root/project"
mkdir -p "$workspace"
results=""
failures=0

# macOS has no `timeout`; fall back to a watcher process like smoke-opencode.sh.
run_timed() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_s" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$timeout_s" "$@"
  else
    "$@" &
    pid=$!
    ( sleep "$timeout_s"; kill "$pid" 2>/dev/null ) &
    watcher=$!
    set +e
    wait "$pid"
    status=$?
    set -e
    kill "$watcher" 2>/dev/null || true
    return "$status"
  fi
}

wanted() {
  [ -z "$only" ] && return 0
  case ",$only," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

# New calls for one harness since the marker line, as tab-separated evidence.
new_calls() {
  tail -n +"$((marker + 1))" "$log" |
    jq -r --arg h "$1" '
      select(._tag == "call" and .harness == $h) |
      [.status, ([.questions[].id] | join(",")),
       ([.answers[]? | if ._tag == "choice" then "\(.choice)@\(.confidence)"
                      elif ._tag == "noul" then "p=\(.noul)"
                      else ._tag end] | join(","))] | @tsv'
}

check() {
  harness=$1
  shift
  if ! wanted "$harness"; then
    results="$results
  $harness: SKIP (not selected)"
    return 0
  fi
  binary=$1
  shift
  if ! command -v "$binary" >/dev/null 2>&1; then
    results="$results
  $harness: FAIL ($binary not on PATH)"
    failures=$((failures + 1))
    return 0
  fi

  marker=$(wc -l < "$log" | tr -d ' ')
  out="$root/$harness.out"
  ( cd "$workspace" && run_timed "$@" ) >"$out" 2>&1 || true

  evidence=$(new_calls "$harness")
  ok=$(printf '%s' "$evidence" | grep -c '^ok' || true)
  if [ "$ok" -ge 1 ]; then
    results="$results
  $harness: PASS ($(printf '%s' "$evidence" | head -1))"
  else
    results="$results
  $harness: FAIL (no ok call event; answer: $(tail -1 "$out" | cut -c1-100))"
    failures=$((failures + 1))
  fi
}

echo "prompt: $prompt"
echo "log: $log"

check opencode opencode \
  opencode run --auto --model "$opencode_model" "$prompt"
check claude-code claude \
  claude -p "$prompt" --allowedTools "$claude_tool"
check pi pi \
  pi -p "$prompt"
check omp omp \
  omp -p --no-title "$prompt"

echo "results:$results"

if [ "$keep" -eq 1 ]; then
  echo "artifacts: $root"
else
  rm -rf "$root"
fi

if [ "$failures" -gt 0 ]; then
  echo "smoke test FAILED ($failures harness(es))" >&2
  exit 1
fi
echo "smoke test passed"
