#!/bin/sh
# Nightly telemetry refresh: label sessions, audit claims, then check the meter.
#
# launchd does not inherit a shell environment, so the API key comes from the
# launchd session (`launchctl setenv TYPESAFE_API_KEY ...`) or from
# ~/.config/jev/env (chmod 600). This repo never stores the key.
set -u
repo=$(cd "$(dirname "$0")/.." && pwd)
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

if [ -z "${TYPESAFE_API_KEY:-}" ] && [ -f "$HOME/.config/jev/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.config/jev/env"
fi
if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  log "TYPESAFE_API_KEY not set for launchd; skipping label and audit"
  exit 0
fi

log "label sessions --since 24h --limit 50"
node "$repo/src/cli/jev.ts" label sessions --since 24h --limit 50 || log "label failed"

log "audit run --since 24h"
node "$repo/src/cli/jev.ts" audit run --since 24h || log "audit failed"

if "$repo/scripts/check-metrics.sh" >/dev/null 2>&1; then
  log "metrics check passed"
else
  log "metrics check FAILED (stale meter or broken scrape)"
fi
log "nightly done"
