#!/bin/sh
# UserPromptSubmit hook: inject the Jev directive when the prompt asks for a
# quantitative judgment. Never blocks; prints nothing when nothing matches.
set -u
command -v jev >/dev/null 2>&1 || exit 0
exec jev hook prompt
