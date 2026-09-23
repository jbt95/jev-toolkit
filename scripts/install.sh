#!/bin/sh
# Install the jev MCP launcher into ~/.local/bin.
set -eu
if ! command -v bun >/dev/null 2>&1; then
  echo "error: install Bun before installing jev" >&2
  exit 1
fi
repo=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$HOME/.local/bin"
ln -sfn "$repo/bin/jev" "$HOME/.local/bin/jev"
echo "linked: $HOME/.local/bin/jev -> $repo/bin/jev"
if ! command -v jev >/dev/null 2>&1; then
  echo "warning: $HOME/.local/bin is not on PATH; add it to use 'jev mcp'"
fi
