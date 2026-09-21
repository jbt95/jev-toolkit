#!/bin/sh
# Nightly telemetry refresh: label sessions, audit claims, then check the meter.
#
# launchd does not inherit a shell environment, so the API key comes from the
# launchd session (`launchctl setenv TYPESAFE_API_KEY ...`) or from
# ~/.config/jev/env (chmod 600). This repo never stores the key.
set -u
# Installed as ~/.local/bin/jev-nightly (a symlink into the repo), so resolve
# this script's own symlinks before deriving the repo root from its path.
target=$0
while [ -L "$target" ]; do
  dir=$(cd "$(dirname "$target")" && pwd)
  target=$(readlink "$target")
  case $target in
    /*) ;;
    *) target="$dir/$target" ;;
  esac
done
repo=$(cd "$(dirname "$target")/.." && pwd)
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

if [ -z "${TYPESAFE_API_KEY:-}" ] && [ -f "$HOME/.config/jev/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.config/jev/env"
fi
if [ -z "${TYPESAFE_API_KEY:-}" ] && command -v zsh >/dev/null 2>&1; then
  # launchd starts with a bare environment; ask the user's own shell, whose rc
  # files already hold the key. Nothing is written by this repo.
  key=$(zsh -ic 'printf %s "${TYPESAFE_API_KEY:-}"' 2>/dev/null || true)
  if [ -n "$key" ]; then
    TYPESAFE_API_KEY=$key
    export TYPESAFE_API_KEY
  fi
fi
if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  log "TYPESAFE_API_KEY not set for launchd; skipping label and audit"
  exit 0
fi

# launchd's PATH omits Homebrew; resolve node before running the CLI.
node_bin=${JEV_NODE:-}
if [ -z "$node_bin" ]; then
  node_bin=$(command -v node || true)
fi
if [ -z "$node_bin" ] && [ -x /opt/homebrew/bin/node ]; then
  node_bin=/opt/homebrew/bin/node
fi
if [ -z "$node_bin" ]; then
  log "node not found; cannot run label or audit"
  exit 1
fi

log "label sessions --since 24h --limit 50"
"$node_bin" "$repo/src/cli/jev.ts" label sessions --since 24h --limit 50 || log "label failed"

log "audit run --since 24h"
"$node_bin" "$repo/src/cli/jev.ts" audit run --since 24h || log "audit failed"

if "$repo/scripts/check-metrics.sh" >/dev/null 2>&1; then
  log "metrics check passed"
else
  log "metrics check FAILED (stale meter or broken scrape)"
fi
log "nightly done"
