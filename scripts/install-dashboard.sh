#!/bin/sh
# Install the Jev Impact dashboard and the Prometheus scrape job into the
# claude-code-metrics stack. Idempotent; never rewrites an existing scrape job.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
stack=${JEV_METRICS_STACK:-$HOME/work/claude-code-metrics}
[ -d "$stack" ] || {
  echo "metrics stack not found: $stack (set JEV_METRICS_STACK)"
  exit 1
}

cp "$repo/dashboards/jev-impact.json" "$stack/grafana/dashboards/jev-impact.json"
echo "dashboard installed: $stack/grafana/dashboards/jev-impact.json"
echo "new dashboards appear after: (cd $stack && podman-compose restart grafana)"

if grep -q "jev-meter" "$stack/prometheus/prometheus.yml"; then
  echo "scrape job already present; leaving prometheus.yml untouched"
else
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const src = fs.readFileSync(path, "utf8");
    if (!src.includes("\nrule_files:")) {
      console.error("unexpected prometheus.yml shape: no rule_files section");
      process.exit(1);
    }
    const job =
      "  - job_name: jev-meter\n" +
      "    static_configs:\n" +
      "      - targets: [\"host.containers.internal:8788\"]\n";
    fs.writeFileSync(path, src.replace("\nrule_files:", "\n" + job + "\nrule_files:"));
  ' "$stack/prometheus/prometheus.yml"
  echo "scrape job added: jev-meter -> host.containers.internal:8788"
  echo "restart prometheus to apply: (cd $stack && podman-compose restart prometheus)"
fi
