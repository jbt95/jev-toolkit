#!/bin/sh
# Assert the meter renders every jev_* family, and Prometheus still scrapes it.
#
# Families with no data yet are not failures: the check catches a meter that is
# serving stale code (missing family) or a scrape that stopped working. Data
# presence per family is reported, not enforced.
set -eu
prom=${PROM_URL:-http://localhost:9090}
meter=${METER_URL:-http://127.0.0.1:8788}
failed=0

if ! exposition=$(curl -fsS --max-time 10 "$meter/metrics"); then
  echo "FAIL meter unreachable at $meter"
  exit 1
fi

for metric in \
  jev_calls_total \
  jev_tokens_total \
  jev_sessions_with_calls_total \
  jev_labeled_sessions_with_calls_total \
  jev_labeled_sessions_total \
  jev_opportunities_total \
  jev_compliance_ratio \
  jev_triage_total \
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

exit $failed
