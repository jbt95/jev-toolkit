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
    const file = process.argv[1];
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const start = lines.findIndex((line) => /^scrape_configs:\s*$/.test(line));
    if (start === -1) {
      console.error("unexpected prometheus.yml shape: no scrape_configs section");
      process.exit(1);
    }
    let indent = "  ";
    for (let i = start + 1; i < lines.length; i++) {
      const match = /^(\s*)-\s/.exec(lines[i]);
      if (match !== null) {
        indent = match[1];
        break;
      }
      if (lines[i].trim() !== "" && !/^\s/.test(lines[i])) break;
    }
    lines.splice(
      start + 1,
      0,
      `${indent}- job_name: jev-meter`,
      `${indent}  static_configs:`,
      `${indent}    - targets: ["host.containers.internal:8788"]`,
      "",
    );
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, lines.join("\n"));
    fs.renameSync(tmp, file);
  ' "$stack/prometheus/prometheus.yml"
  echo "scrape job added: jev-meter -> host.containers.internal:8788"
  echo "restart prometheus to apply: (cd $stack && podman-compose restart prometheus)"
fi
