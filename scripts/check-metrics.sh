#!/bin/sh
# Assert the meter renders every jev_* family, and Prometheus still scrapes it.
#
# Families with no data yet are not failures: the check catches a meter that is
# serving stale code (missing family) or a scrape that stopped working. Data
# presence per family is reported, not enforced. Pass --live to append clearly
# named smoke events to the configured event log for dashboard verification.
set -eu

live=0
for arg in "$@"; do
  case "$arg" in
    --live) live=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "usage: $0 [--live]" >&2; exit 2 ;;
  esac
done

prom=${PROM_URL:-http://localhost:9090}
meter=${METER_URL:-http://127.0.0.1:8788}
failed=0
repo=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

record_outcome_events() {
  session=$1
  call=$2
  JEV_HARNESS=cli "$repo/bin/jev" checkpoint \
    --kind test --result pass --source ci --session "$session" --call-id "$call" >/dev/null
  JEV_HARNESS=cli "$repo/bin/jev" correction \
    --kind accepted --source operator --session "$session" --call-id "$call" >/dev/null
  JEV_HARNESS=cli "$repo/bin/jev" cohort \
    --name assisted --source experiment --session "$session" >/dev/null
}

if [ "$live" -eq 1 ]; then
  smoke_session="jev-smoke-$(date +%s)"
  smoke_call="$smoke_session-call"
  echo "LIVE smoke data: session=$smoke_session"
  record_outcome_events "$smoke_session" "$smoke_call"
fi

if ! exposition=$(curl -fsS --max-time 10 "$meter/metrics"); then
  echo "FAIL meter unreachable at $meter"
  exit 1
fi

for metric in \
  jev_calls_total \
  jev_call_purposes_total \
  jev_call_state_size_total \
  jev_call_questions_total \
  jev_tokens_total \
  jev_sessions_with_calls_total \
  jev_labeled_sessions_with_calls_total \
  jev_labeled_sessions_total \
  jev_opportunities_total \
  jev_compliance_ratio \
  jev_triage_total \
  jev_checkpoints_total \
  jev_checkpoint_success_ratio \
  jev_checkpoint_links_total \
  jev_corrections_total \
  jev_cohort_assignments_total \
  jev_latency_seconds \
  jev_confidence \
  jev_sessions_total \
  jev_waste_total \
  jev_session_friction \
  jev_noul_probability \
  jev_call_errors_total \
  jev_session_cost_usd \
  jev_session_tokens_total \
  jev_session_tool_errors_total \
  jev_session_stop_reasons_total \
  jev_reviews_total \
  jev_review_score \
  jev_review_direction_total \
  jev_log_lines_total \
  jev_last_event_timestamp_seconds \
  jev_meter_start_timestamp_seconds; do
  if printf '%s\n' "$exposition" | grep -q "^# TYPE $metric "; then
    if curl -fsS --get "$prom/api/v1/query" \
      --data-urlencode "query=count({__name__=~\"$metric.*\"})" 2>/dev/null |
      grep -q '"value"'; then
      echo "PASS $metric"
    else
      echo "PASS $metric (meter renders; no series in Prometheus yet)"
    fi
  else
    echo "FAIL $metric (missing from meter exposition: stale meter code?)"
    failed=1
  fi
done

scrape=$(curl -fsS --get "$prom/api/v1/query" --data-urlencode 'query=up{job="jev-meter"}' 2>/dev/null || true)
if printf '%s' "$scrape" | grep -q '"value":\[[0-9.]*,"1"\]'; then
  echo "PASS prometheus scrape"
else
  echo "FAIL prometheus scrape (up != 1 for job jev-meter)"
  failed=1
fi

if [ "$live" -eq 1 ]; then
  live_exposition=$(curl -fsS --max-time 10 "$meter/metrics")
  for sample in \
    "jev_checkpoints_total{harness=\"cli\",kind=\"test\",result=\"pass\"} " \
    "jev_checkpoint_success_ratio{harness=\"cli\",kind=\"test\"} " \
    "jev_checkpoint_links_total{harness=\"cli\",linked=\"true\"} " \
    "jev_corrections_total{harness=\"cli\",kind=\"accepted\"} " \
    "jev_cohort_assignments_total{harness=\"cli\",cohort=\"assisted\"} "; do
    if printf '%s\n' "$live_exposition" | grep -Fq "$sample"; then
      echo "PASS live $sample"
    else
      echo "FAIL live $sample"
      failed=1
    fi
  done

  for query in \
    'jev_checkpoints_total{harness="cli",kind="test",result="pass"}' \
    'jev_checkpoint_success_ratio{harness="cli",kind="test"}' \
    'jev_checkpoint_links_total{harness="cli",linked="true"}' \
    'jev_corrections_total{harness="cli",kind="accepted"}' \
    'jev_cohort_assignments_total{harness="cli",cohort="assisted"}'; do
    prom_result=""
    attempt=0
    while [ "$attempt" -lt 40 ]; do
      prom_result=$(curl -fsS --get "$prom/api/v1/query" \
        --data-urlencode "query=$query" 2>/dev/null || true)
      if printf '%s' "$prom_result" | grep -q '"value"'; then break; fi
      attempt=$((attempt + 1))
      sleep 1
    done
    if printf '%s' "$prom_result" | grep -q '"value"'; then
      echo "PASS live Prometheus $query"
    else
      echo "FAIL live Prometheus $query"
      failed=1
    fi
  done

  # A new Prometheus series has no prior sample for increase() to compare
  # against. Append a second set after the raw series is visible so the
  # dashboard's range-based panels observe a real increment.
  repeat_session="$smoke_session-repeat"
  repeat_call="$repeat_session-call"
  record_outcome_events "$repeat_session" "$repeat_call"
  for query in \
    'sum by (kind, result) (increase(jev_checkpoints_total[30m])) > 0' \
    'sum by (kind) (increase(jev_corrections_total[30m])) > 0' \
    'sum by (linked) (increase(jev_checkpoint_links_total[30m])) > 0' \
    'sum by (cohort) (increase(jev_cohort_assignments_total[30m])) > 0'; do
    prom_result=""
    attempt=0
    while [ "$attempt" -lt 40 ]; do
      prom_result=$(curl -fsS --get "$prom/api/v1/query" \
        --data-urlencode "query=$query" 2>/dev/null || true)
      if printf '%s' "$prom_result" | grep -q '"value"'; then break; fi
      attempt=$((attempt + 1))
      sleep 1
    done
    if printf '%s' "$prom_result" | grep -q '"value"'; then
      echo "PASS live dashboard $query"
    else
      echo "FAIL live dashboard $query"
      failed=1
    fi
  done
fi

# Exercise the new outcome producers against an isolated event log. This proves
# the CLI -> event schema -> meter path without adding smoke data to the user's
# real log.
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/jev-metrics.XXXXXX")
fixture_data="$fixture_root/data"
meter_pid=""

cleanup_fixture() {
  if [ -n "$meter_pid" ]; then
    kill "$meter_pid" 2>/dev/null || true
    wait "$meter_pid" 2>/dev/null || true
  fi
  rm -rf "$fixture_root"
}
trap cleanup_fixture EXIT

JEV_DATA_DIR="$fixture_data" JEV_HARNESS=cli "$repo/bin/jev" checkpoint \
  --kind test --result pass --source ci --session smoke-session --call-id smoke-call >/dev/null
JEV_DATA_DIR="$fixture_data" JEV_HARNESS=cli "$repo/bin/jev" correction \
  --kind accepted --source operator --session smoke-session --call-id smoke-call >/dev/null
JEV_DATA_DIR="$fixture_data" JEV_HARNESS=cli "$repo/bin/jev" cohort \
  --name assisted --source experiment --session smoke-session >/dev/null

meter_port=$(node -e '
  import { createServer } from "node:net";
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address !== null && typeof address === "object") console.log(address.port);
    server.close();
  });
')
JEV_DATA_DIR="$fixture_data" "$repo/bin/jev" meter serve --port "$meter_port" \
  >"$fixture_root/meter.log" 2>&1 &
meter_pid=$!

fixture_exposition=""
attempt=0
while [ "$attempt" -lt 50 ]; do
  fixture_exposition=$(curl -fsS --max-time 1 "http://127.0.0.1:$meter_port/metrics" 2>/dev/null || true)
  if [ -n "$fixture_exposition" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 0.1
done

if [ -z "$fixture_exposition" ]; then
  echo "FAIL isolated outcome meter"
  failed=1
else
  for sample in \
    'jev_checkpoints_total{harness="cli",kind="test",result="pass"} 1' \
    'jev_checkpoint_success_ratio{harness="cli",kind="test"} 1' \
    'jev_checkpoint_links_total{harness="cli",linked="true"} 1' \
    'jev_corrections_total{harness="cli",kind="accepted"} 1' \
    'jev_cohort_assignments_total{harness="cli",cohort="assisted"} 1'; do
    if printf '%s\n' "$fixture_exposition" | grep -Fq "$sample"; then
      echo "PASS isolated $sample"
    else
      echo "FAIL isolated $sample"
      failed=1
    fi
  done
fi

exit $failed
