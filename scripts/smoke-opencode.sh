#!/bin/sh
# End-to-end smoke test: opencode + jev-toolkit.
#
# Launches a real opencode session with a generic four-part task (deploy
# judgment, claim check, code review, commit message) that the jev tools serve
# WITHOUT naming them, to test whether the agent discovers and routes through
# the tools on its own. Then checks the event log those calls produced and
# every operator surface: mcp protocol, ask, events, hook, check commit,
# triage review, triage failure (loop breaker), eval pack, audit, label,
# and meter.
#
# Note: with the generic prompt the agent-call checks double as a discovery
# probe — a FAIL there means the agent did not route through Jev on its own,
# which is itself the finding (see the compliance/coverage metrics).
#
# This is NOT part of `npm test`: it calls the live TypeSafe API and the
# configured model provider, and it spends real tokens. Run it by hand after
# wiring or pack changes.
#
# Usage:
#   scripts/smoke-opencode.sh [--keep] [--agent-only] [--no-agent]
#
#   --keep        keep the temp workspace and logs even on success
#   --agent-only  skip the operator CLI checks
#   --no-agent    skip the opencode session; only run operator checks
#
# Env:
#   JEV_SMOKE_OPENCODE opencode binary to run (default: opencode)
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

opencode_bin="${JEV_SMOKE_OPENCODE:-opencode}"

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
export JEV_HARNESS=opencode
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
You are working in a small TypeScript repo. Do the following four tasks in order. Do not modify any files. Use whatever tools look best suited for each task, including any judgment or review tools the harness offers.

Task 1 - deployment readiness. The situation: service "api", environment "staging", tests are green, zero incidents last week. Decide whether it is safe to deploy now, how confident we should be in this deployment, and the best next action (deploy now vs hold for more evidence). Give a calibrated number for every judgment you make.

Task 2 - test report check. Someone claims "all 12 tests pass" and "coverage is 90%". The actual test run output is: "test run 2026-09-17: 12 passed, 0 failed, 1 skipped; coverage: 82%". Say which claims hold up and which do not, with confidence for each verdict.

Task 3 - code review. Run `git diff` in the current directory first. The change is supposed to "make slugify handle separators and unicode safely". Review it across correctness, complexity, readability, modularity, coupling, changeability, test quality, and security, scoring each dimension. Then review it a second time, comparing directly against your first review, and report what improved, stayed the same, or regressed.

Task 4 - commit message. The file .smoke-message.txt holds the proposed commit message for this change. Check whether it is a good message (run whatever check fits) and say pass or fail.

Final answer: one line per task, exactly "step 1: ok" or "step 1: failed - <reason>", through step 4. Nothing else.
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
  hook_verify=$(printf '%s' '{"prompt":"What are the odds this ships on time?"}' | jev hook prompt --verify)
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
  audit_out=$(jev audit run --since 1h --harness opencode --dry-run)
  check_contains "audit run scans opencode" "opencode" "$audit_out"
  prompts_out=$(jev audit prompts --since 1h)
  check_contains "audit prompts measures the trigger" "prompts=" "$prompts_out"
  label_out=$(jev label sessions --since 1h --harness opencode --dry-run)
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
