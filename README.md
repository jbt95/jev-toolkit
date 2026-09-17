# jev-toolkit

Multi-harness integration for [TypeSafe/Jev](https://docs.typesafe.ai) — the
System One decision model. One repo, four harnesses (Pi, OMP, Claude Code,
OpenCode2), one local event log, Prometheus impact metrics on the existing
Grafana stack.

Built as an **Effect** codebase (v4 RC): services with Layers, typed errors,
Schema-validated boundaries, no runtime dependencies besides `effect`.

## What it does

- **Triggers** — makes Jev fire deterministically on quantitative judgments
  (plugin hooks, prompt transforms), instead of relying on instructions the
  agent can ignore.
- **Triage question packs** — reviewer findings, harness/CI failures, commit
  conformance.
- **Trace labeling** — classifies agent sessions (outcome, friction, waste)
  into the metrics stack.
- **Impact metrics** — every call, opportunity, and label lands in one JSONL
  event log; `jev meter serve` exposes Prometheus series scraped by
  `~/work/claude-code-metrics` and rendered as the `Jev Impact` dashboard at
  http://localhost:3000/d/jev-impact.

## Usage

```console
jev ask                                  # {state, questions, model?} JSON on stdin
jev triage failure --transcript FILE     # classify a failure; loop breaker built in
jev triage review --input findings.json  # route review findings: blockers/cosmetic/questions
jev check commit --message-file FILE     # commit conformance (also --replay N [--repo DIR])
jev label sessions --since 24h           # label sessions: outcome / friction / waste
jev audit run --since 24h                # detect quantitative claims agents made
jev meter serve                          # Prometheus metrics on 127.0.0.1:8788
jev mcp                                  # MCP server: the single typesafe_ask surface
```

See [docs/agent-integration-guide.md](docs/agent-integration-guide.md) for the
event schema, metric catalogue, per-harness install, and troubleshooting.

## Layout

```
src/core/           shared Effect services + Schema (event log, Jev client, metrics, audit)
src/mcp/server.ts   stdio MCP server (`jev mcp`) — the single judgment tool surface
src/cli/jev.ts      CLI: ask | events | meter | audit | triage | check | label | hook | mcp
bin/jev             shim for ~/.local/bin
src/question-packs/ reviewer triage, failure triage, commit conformance, labels
integrations/       opencode2 | claude-code | pi | omp
dashboards/         canonical Grafana dashboard JSON + install script
docs/superpowers/plans/  implementation plans
```

## Tooling

`oxlint` (with vendored anti-slop rules: generic + Effect groups), `oxfmt`
formatter, `tsc` typecheck, `vitest` tests. All four gates run before every
commit:

```console
npm run lint && npm run format:check && npm run typecheck && npm test
```

## Install

Fully documented per harness in the implementation plan:
`docs/superpowers/plans/2026-09-16-jev-toolkit.md`.

Requires: Node >= 26, `TYPESAFE_API_KEY` in the harness environments, and the
`~/work/claude-code-metrics` stack for dashboards.

## Privacy

Only sanitized state (summaries, counts, masked features) is ever sent to
`api.typesafe.ai`. Raw code, transcripts, secrets, and credentials never
leave the machine. The event log is local-only.
