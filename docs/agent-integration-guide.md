# Agent integration guide

How jev-toolkit wires Jev/TypeSafe into Pi, OMP, Claude Code, and OpenCode2 —
and how to measure it.

## Architecture in one paragraph

The `typesafe_ask` tool lives once, in `jev mcp` (a stdio MCP server); every
MCP-capable harness connects to it. Harness integrations add only what MCP
cannot: deterministic triggers (prompt directives, input transforms, tool
hooks). The `jev` CLI is the operator surface (`ask`, `triage`, `check`,
`label`, `audit`, `meter`, `hook`) and the fallback tool for harnesses without
MCP. Every judgment, triage, and label appends to one local event log.

## Event schema

One JSONL file: `~/.local/share/jev/events.jsonl` (override `JEV_DATA_DIR`).
Four kinds, all schema-validated (`src/core/schema.ts`):

```jsonc
{"_tag":"call","ts":"…","harness":"opencode2","sessionID":"…","model":"jev-1.13.0",
 "latencyMs":728,"status":"ok","questions":[{"id":"is_dupe","type":"noul"}],
 "answers":{"is_dupe":{"_tag":"noul","noul":0.99}},"tokens":{"input":279,"output":22}}

{"_tag":"opportunity","ts":"…","harness":"claude-code","sessionID":"…",
 "source":"assistant_message","pattern":"percent","matched":false}

{"_tag":"triage","ts":"…","harness":"cli","feature":"failure|review|commit",
 "summary":{"repeats":3,"escalate":1}}          // numeric counts only, never text

{"_tag":"session_label","ts":"…","harness":"opencode2","sessionID":"…",
 "outcome":"shipped","friction":2,"waste":"none","taskType":"review"}
```

## Metric catalogue (`jev meter serve`, port 8788)

| Metric | Labels | Meaning |
|---|---|---|
| `jev_calls_total` | harness, status | Jev API calls (ok/error) |
| `jev_tokens_total` | harness, kind | TypeSafe input/output tokens |
| `jev_sessions_with_calls_total` | harness | sessions with ≥1 Jev call |
| `jev_opportunities_total` | harness, matched | detected quantitative claims (audit) |
| `jev_compliance_ratio` | harness | matched / all claims |
| `jev_triage_total` | feature | triage runs (failure/review/commit) |
| `jev_latency_seconds` | harness, le | call latency histogram |
| `jev_confidence` | primitive, le | answer confidence histogram |
| `jev_sessions_total` | harness, outcome | labeled sessions |
| `jev_waste_total` | harness, pattern | dominant waste pattern |
| `jev_session_friction` | harness, le | friction histogram |

Dashboard: `Jev Impact` (`http://localhost:3000/d/jev-impact`), provisioned in
`~/work/claude-code-metrics`. Smoke: `scripts/check-metrics.sh`.

## Per-harness install

**OpenCode2** — MCP entry in the global `opencode.json(c)` plus the trigger
shim plugin. See `integrations/opencode2/README.md`. After meter-code edits run
`opencode2 service restart`; a stale plugin state clears on restart.

**Claude Code** — `claude plugin marketplace add ~/personal/jev-toolkit` then
`claude plugin install jev-toolkit@jev-toolkit`. The plugin ships the MCP
declaration, the `UserPromptSubmit` directive hook, the Stop failure hook, and
the `jev` skill. Reinstall after manifest changes; restart Claude Code.
See `integrations/claude-code/README.md`.

**Pi** — symlink `integrations/pi` into `~/.pi/agent/extensions/jev`. The
extension is self-contained (spawns `jev ask` / `jev triage failure`).
See `integrations/pi/README.md`.

**OMP** — `omp plugin install ~/personal/jev-toolkit` (root manifest declares
`pi.extensions`); verify with `omp plugin doctor`. See
`integrations/omp/README.md`.

## Troubleshooting

- **MCP tool missing in OpenCode2** — check `opencode2 plugin list`; a
  `(failed)` plugin entry clears on `opencode2 service restart`.
- **No events** — `jev events | tail`; the log path honors `JEV_DATA_DIR`.
- **Dashboard stale/empty** — restart the meter after meter-code edits
  (`launchctl bootout gui/$UID/com.jev.meter && launchctl bootstrap …`), then
  `podman-compose restart grafana` if a dashboard file changed; Prometheus
  scrapes every 30s.
- **MCP tool errors** — the tool returns the error as text; missing
  `TYPESAFE_API_KEY` reports as a config error, never a guess.
- **Pi/OMP extension fails to load** — jiti resolves relative paths lexically
  and bare imports from the loading location; keep extensions self-contained
  (they are by design) and never `npm install` inside integration folders.

## Policy: log-first

Triggers observe and record before they gate. The only suppression paths are
the loop breaker (fires once at the third identical failure) and any future
secret trap; both are covered by fixtures. Never send secrets, credentials, or
raw proprietary code in `state` — sanitized summaries and counts only.
