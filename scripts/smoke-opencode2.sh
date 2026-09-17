#!/bin/sh
# End-to-end smoke test: opencode2 + jev-toolkit.
#
# Launches a real opencode2 session whose prompt exercises the three MCP tools
# (typesafe_ask, typesafe_verify, typesafe_review) in order, then checks the
# event log those calls produced and every operator surface: mcp protocol,
# ask, events, hook, check commit, triage review, triage failure (loop
# breaker), eval pack, audit, label, and meter.
#
# This is NOT part of `npm test`: it calls the live TypeSafe API and the
# configured model provider, and it spends real tokens. Run it by hand after
# wiring or pack changes.
#
# Usage:
#   scripts/smoke-opencode2.sh [--keep] [--agent-only] [--no-agent]
#
#   --keep        keep the temp workspace and logs even on success
#   --agent-only  skip the operator CLI checks
#   --no-agent    skip the opencode2 session; only run operator checks
#
# Env:
#   JEV_SMOKE_OPENCODE opencode binary to run (default: opencode2)
#   JEV_SMOKE_MODEL    model for the opencode session (provider/model)
#   JEV_SMOKE_TIMEOUT  seconds before the agent session is killed (default 420)

set -eu

keep=0
run_agent=1
run_operator=1
for arg in "$@"; do
  case "$arg" in
    --keep) keep=1 ;;
    --agent-only) run_operator=0 ;;
    --no-agent) run_agent=0 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

opencode_bin="${JEV_SMOKE_OPENCODE:-opencode2}"

# ---------------------------------------------------------------- preflight
for tool in "$opencode_bin" jev jq git curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: $tool" >&2
    exit 2
  fi
done
if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  echo "TYPESAFE_API_KEY is not set; export it before running the smoke test" >&2
  exit 2
fi

# ---------------------------------------------------------------- fixtures
root=$(mktemp -d "${TMPDIR:-/tmp}/jev-smoke.XXXXXX")
workspace="$root/project"
export JEV_DATA_DIR="$root/data"
export JEV_HARNESS=opencode2
mkdir -p "$JEV_DATA_DIR" "$workspace/src"

failures=0
pass=0
meter_pid=""

cleanup() {
  if [ -n "$meter_pid" ]; then
    kill "$meter_pid" 2>/dev/null || true
    wait "$meter_pid" 2>/dev/null || true
  fi
  if [ "$keep" -eq 0 ] && [ "$failures" -eq 0 ]; then
    rm -rf "$root"
  else
    echo "artifacts kept at $root"
  fi
}
trap cleanup EXIT

run_timed() {
  limit="${JEV_SMOKE_TIMEOUT:-420}"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$limit" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$limit" "$@"
  else
    "$@" &
    pid=$!
    ( sleep "$limit"; kill "$pid" 2>/dev/null ) &
    watcher=$!
    set +e
    wait "$pid"
    status=$?
    set -e
    kill "$watcher" 2>/dev/null || true
    return "$status"
  fi
}

check_eq() {
  if [ "$2" = "$3" ]; then
    echo "  PASS $1 ($3)"
    pass=$((pass + 1))
  else
    echo "  FAIL $1 (expected $2, got $3)"
    failures=$((failures + 1))
  fi
}

check_ge() {
  if [ "$3" -ge "$2" ]; then
    echo "  PASS $1 ($3)"
    pass=$((pass + 1))
  else
    echo "  FAIL $1 (expected >= $2, got $3)"
    failures=$((failures + 1))
  fi
}

check_contains() {
  case "$3" in
    *"$2"*)
      echo "  PASS $1"
      pass=$((pass + 1))
      ;;
    *)
      echo "  FAIL $1 (missing: $2)"
      failures=$((failures + 1))
      ;;
  esac
}

# A tiny repo with one commit and one uncommitted change for the review tool.
git -C "$workspace" init -q
cat > "$workspace/src/slug.ts" <<'EOF'
export const slugify = (input: string): string => input.trim().toLowerCase().replace(/\s+/gu, "-");
EOF
git -C "$workspace" -c user.email=smoke@example.com -c user.name=Smoke add .
git -C "$workspace" -c user.email=smoke@example.com -c user.name=Smoke commit -q -m "feat(slug): add slug helper"
cat > "$workspace/src/slug.ts" <<'EOF'
export const slugify = (input: string): string => {
  let out = "";
  for (const ch of input) {
    if (ch === " " || ch === "_") out += "-";
    else if (/[A-Za-z0-9-]/.test(ch)) out += ch.toLowerCase();
  }
  if (out.startsWith("-")) out = out.slice(1);
  return out;
};

export const truncate = (input: string, limit: number): string => input.slice(0, limit);
EOF
cat > "$workspace/.smoke-message.txt" <<'EOF'
feat(slug): normalize input before building slugs

Unicode and repeated separators produced invalid slugs, so slugify now walks
the input and keeps only safe characters. Covered by the slug tests.
Refs: #42
EOF

cat > "$root/prompt.txt" <<'EOF'
You are running a jev-toolkit smoke test. Follow the steps in order and use the jev MCP tools (they may appear with a "jev_" prefix). Do not modify any files. If a tool call fails validation, correct the arguments and retry once.

Step 1 - typesafe_ask. Call it once with:
state: {"service":"api","environment":"staging","tests":"green","incidents_last_week":0}
questions:
  safe_to_deploy: {"_tag":"noul","instructions":"Is it safe to deploy this service to staging now?"}
  deploy_confidence: {"_tag":"score","instructions":"How confident should we be in this deployment?","criteria":["No confidence","Low","Moderate","High","Certain"]}
  next_action: {"_tag":"choice","instructions":"What is the best next action?","criteria":{"deploy":"deploy now","hold":"hold for more evidence"}}

Step 2 - typesafe_verify. Call it once with:
claims: [{"id":"c0","text":"all 12 tests pass"},{"id":"c1","text":"coverage is 90%"}]
evidence: "test run 2026-09-17: 12 passed, 0 failed, 1 skipped; coverage: 82%"

Step 3 - typesafe_review. Run `git diff` in the current directory first. Then call typesafe_review with:
task: "make slugify handle separators and unicode safely"
diff: the exact output of git diff
Then call typesafe_review a second time with the same task and diff, and previousEvaluation set to {"dimensions": <the dimensions array from the first result>}, to get before/after directions.

Step 4 - commit check. Run: jev check commit --message-file .smoke-message.txt

Final answer: one line per step, exactly "step 1: ok" or "step 1: failed - <reason>", through step 4. Nothing else.
EOF

# ---------------------------------------------------------------- agent run
if [ "$run_agent" -eq 1 ]; then
  echo "== ${opencode_bin} session (model: ${JEV_SMOKE_MODEL:-default}, timeout: ${JEV_SMOKE_TIMEOUT:-420}s) =="
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  set +e
  if [ -n "${JEV_SMOKE_MODEL:-}" ]; then
    (cd "$workspace" && run_timed "$opencode_bin" run --standalone --auto -m "$JEV_SMOKE_MODEL" \
      "$(cat "$root/prompt.txt")") >"$root/opencode.log" 2>&1
  else
    (cd "$workspace" && run_timed "$opencode_bin" run --standalone --auto \
      "$(cat "$root/prompt.txt")") >"$root/opencode.log" 2>&1
  fi
  agent_status=$?
  set -e
  echo "${opencode_bin} exit: $agent_status"
  tail -n 40 "$root/opencode.log" | sed 's/^/  | /'
  check_eq "opencode run exits 0" 0 "$agent_status"

  # ------------------------------------------------------------- event log
  echo "== agent tool calls =="
  events_file="$JEV_DATA_DIR/events.jsonl"
  if [ ! -s "$events_file" ]; then
    echo "  note: no events in the isolated log; falling back to the default log"
    events_file="$HOME/.local/share/jev/events.jsonl"
  fi
  if [ ! -s "$events_file" ]; then
    echo "  FAIL no event log found; is the jev MCP server wired in opencode?"
    failures=$((failures + 1))
  else
    ok_calls=$(jq -s --arg start "$started_at" \
      '[.[] | select(._tag=="call" and .status=="ok" and (.ts[0:19] >= $start))] | length' "$events_file")
    verify_calls=$(jq -s --arg start "$started_at" \
      '[.[] | select(._tag=="call" and (.ts[0:19] >= $start)) | select(any(.questions[]?; .id | test("^c[0-9]+_verdict$")))] | length' "$events_file")
    review_calls=$(jq -s --arg start "$started_at" \
      '[.[] | select(._tag=="call" and (.ts[0:19] >= $start)) | select(any(.questions[]?; .id | test("^(correctness|cognitive_complexity|readability|modularity|coupling|changeability|test_quality|security)_(applicable|score|direction)$")))] | length' "$events_file")
    verify_events=$(jq -s --arg start "$started_at" \
      '[.[] | select(._tag=="triage" and .feature=="verify" and (.ts[0:19] >= $start))] | length' "$events_file")
    review_events=$(jq -s --arg start "$started_at" \
      '[.[] | select(._tag=="review" and (.ts[0:19] >= $start))] | length' "$events_file")
    direction_count=$(jq -s --arg start "$started_at" \
      '[.[] | select(._tag=="review" and (.ts[0:19] >= $start)) | .dimensions | to_entries[] | select(.value.direction != null)] | length' "$events_file")
    ask_calls=$((ok_calls - verify_calls - review_calls))
    check_ge "typesafe_ask calls" 1 "$ask_calls"
    check_ge "typesafe_verify calls" 1 "$verify_calls"
    check_ge "typesafe_review calls" 1 "$review_calls"
    check_ge "verify triage events" 1 "$verify_events"
    check_ge "review events" 1 "$review_events"
    check_ge "review before/after directions" 1 "$direction_count"
  fi
fi

# ------------------------------------------------------------ operator CLI
if [ "$run_operator" -eq 1 ]; then
  echo "== mcp protocol =="
  proto=$(printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jev mcp | tail -n 1)
  tools=$(printf '%s' "$proto" | jq -r '.result.tools[].name' 2>/dev/null | tr '\n' ' ')
  check_contains "tools/list: typesafe_ask" "typesafe_ask" "$tools"
  check_contains "tools/list: typesafe_verify" "typesafe_verify" "$tools"
  check_contains "tools/list: typesafe_review" "typesafe_review" "$tools"

  echo "== ask, events, hook =="
  ask_out=$(printf '%s' \
    '{"state":{"service":"api"},"questions":{"ok":{"_tag":"noul","instructions":"Is the service healthy?"}}}' \
    | jev ask)
  check_contains "jev ask answers" "p(yes)=" "$ask_out"
  events_out=$(jev events --n 5)
  check_contains "jev events tails the log" '"call"' "$events_out"
  hook_hit=$(printf '%s' '{"prompt":"Should we ship the parser refactor today?"}' | jev hook prompt)
  check_contains "hook prompt fires" "typesafe_ask" "$hook_hit"
  hook_miss=$(printf '%s' '{"prompt":"rename local variable x"}' | jev hook prompt)
  check_eq "hook prompt stays quiet" "" "$hook_miss"
  hook_verify=$(printf '%s' '{"prompt":"Should we ship the parser refactor today?"}' | jev hook prompt --verify)
  check_contains "hook prompt --verify confirms" "typesafe_ask" "$hook_verify"

  echo "== check commit =="
  set +e
  commit_out=$(jev check commit --message-file "$workspace/.smoke-message.txt")
  commit_status=$?
  set -e
  check_eq "conforming message exits 0" 0 "$commit_status"
  check_contains "conforming message output" "pass: true" "$commit_out"
  printf 'wip\n' > "$root/bad-message.txt"
  set +e
  bad_commit_out=$(jev check commit --message-file "$root/bad-message.txt")
  bad_commit_status=$?
  set -e
  check_eq "non-conforming message exits 1" 1 "$bad_commit_status"
  check_contains "non-conforming message output" "pass: false" "$bad_commit_out"

  echo "== triage review =="
  cat > "$root/findings.json" <<'EOF'
{"findings":[{"id":"f1","title":"unbounded retry loop","detail":"the retry loop can spin forever when the endpoint keeps failing"}]}
EOF
  review_out=$(jev triage review --input "$root/findings.json")
  check_contains "findings are routed" '"blockers"' "$review_out"

  echo "== triage failure (loop breaker) =="
  printf 'Error: connect ECONNREFUSED 127.0.0.1:6379\n' > "$root/failure.txt"
  failure_out=""
  i=0
  while [ "$i" -lt 3 ]; do
    failure_out=$(jev triage failure --text "$root/failure.txt")
    i=$((i + 1))
  done
  check_contains "failure is classified" "failure class:" "$failure_out"
  check_contains "loop breaker escalates on the third repeat" "ESCALATE" "$failure_out"

  echo "== eval pack =="
  jq -n --arg msg "$(cat "$workspace/.smoke-message.txt")" \
    '{pack:"commit",cases:[{id:"c1",input:{message:$msg},expected:{passed:1,failed:0}}]}' \
    > "$root/fixtures.json"
  eval_out=$(jev eval pack --fixtures "$root/fixtures.json" --repeat 2)
  check_contains "pack lab runs" "pack commit" "$eval_out"
  check_contains "pack lab agrees with the fixture" "agreed=1" "$eval_out"

  echo "== audit, label =="
  audit_out=$(jev audit run --since 1h --harness opencode2 --dry-run)
  check_contains "audit run scans opencode2" "opencode2" "$audit_out"
  prompts_out=$(jev audit prompts --since 1h)
  check_contains "audit prompts measures the trigger" "prompts=" "$prompts_out"
  label_out=$(jev label sessions --since 1h --harness opencode2 --dry-run)
  check_contains "label sessions digests" '"sessions"' "$label_out"

  echo "== meter =="
  port=$((18000 + ($$ % 1000)))
  jev meter serve --port "$port" >/dev/null 2>&1 &
  meter_pid=$!
  sleep 1
  set +e
  health=$(curl -fsS "http://127.0.0.1:$port/health")
  metrics=$(curl -fsS "http://127.0.0.1:$port/metrics")
  set -e
  check_eq "meter health" "ok" "$health"
  check_contains "meter exposes jev series" "jev_calls_total" "$metrics"
  kill "$meter_pid" 2>/dev/null || true
  wait "$meter_pid" 2>/dev/null || true
  meter_pid=""
fi

echo
echo "smoke: $pass passed, $failures failed"
if [ "$failures" -gt 0 ]; then
  exit 1
fi
