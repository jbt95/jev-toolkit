#!/bin/sh
# Install the jev CLI into ~/.local/bin.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$HOME/.local/bin"
ln -sfn "$repo/bin/jev" "$HOME/.local/bin/jev"
echo "linked: $HOME/.local/bin/jev -> $repo/bin/jev"
if ! command -v jev >/dev/null 2>&1; then
  echo "warning: $HOME/.local/bin is not on PATH; add it to use 'jev' directly"
fi
