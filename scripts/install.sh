#!/bin/sh
# Install the jev CLI into ~/.local/bin. The launchd jobs in launchd/ call the
# shims by name, so they keep working when the repo moves.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$HOME/.local/bin"
ln -sfn "$repo/bin/jev" "$HOME/.local/bin/jev"
ln -sfn "$repo/scripts/nightly.sh" "$HOME/.local/bin/jev-nightly"
echo "linked: $HOME/.local/bin/jev -> $repo/bin/jev"
echo "linked: $HOME/.local/bin/jev-nightly -> $repo/scripts/nightly.sh"
if ! command -v jev >/dev/null 2>&1; then
  echo "warning: $HOME/.local/bin is not on PATH; add it to use 'jev' directly"
fi
