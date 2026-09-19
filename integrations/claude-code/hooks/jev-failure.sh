#!/bin/sh
# Stop hook: classify the last failure (warn-only; never blocks the turn).
# Prints the classification only when it blocks work or the loop breaker fires.
set -u
command -v jev >/dev/null 2>&1 || exit 0
path=$(python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("transcript_path",""))
except Exception: print("")' 2>/dev/null)
[ -n "$path" ] || exit 0
out=$(JEV_HARNESS=claude-code jev triage failure --transcript "$path" 2>/dev/null) || exit 0
[ -n "$out" ] || exit 0
printf '%s\n' "$out" | awk '
  /^blocks_work: p\(yes\)=/ { split($0, parts, "="); if (parts[2] + 0 >= 0.7) keep = 1 }
  /^ESCALATE:/ { keep = 1 }
  { lines[NR] = $0 }
  END { if (keep) for (i = 1; i <= NR; i++) print lines[i] }'
exit 0
