#!/bin/sh
# Assert every jev_* metric family is present in Prometheus.
set -eu
prom=${PROM_URL:-http://localhost:9090}
failed=0
for metric in \
  jev_calls_total \
  jev_tokens_total \
  jev_sessions_with_calls_total \
  jev_labeled_sessions_with_calls_total \
  jev_labeled_sessions_total \
  jev_opportunities_total \
  jev_compliance_ratio \
  jev_triage_total \
  jev_latency_seconds_count \
  jev_confidence_count \
  jev_sessions_total \
  jev_waste_total \
  jev_session_friction_count; do
  if curl -fsS --get "$prom/api/v1/query" --data-urlencode "query=count($metric)" 2>/dev/null | grep -q '"value"'; then
    echo "PASS $metric"
  else
    echo "FAIL $metric (no series in Prometheus)"
    failed=1
  fi
done
exit $failed
