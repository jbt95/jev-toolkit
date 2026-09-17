# Architecture

How the pieces fit together: one judgment client, one MCP surface, one event
log, and a meter that turns the log into Prometheus series.

## System map

```mermaid
flowchart LR
  HARNESS["MCP-capable harness"]

  subgraph judgment["Judgment surface"]
    MCP["jev mcp<br/>typesafe_ask over stdio"]
    ASK["jev ask<br/>stdin fallback"]
  end

  subgraph operator["Operator CLI"]
    TRIAGE["triage failure · review"]
    CHECK["check commit"]
    AUDIT["audit run · prompts"]
    LABEL["label sessions"]
  end

  API["TypeSafe API<br/>api.typesafe.ai/v1/systemone"]
  CLIENT["JevClient<br/>retry-safe fetch · 120s timeout"]
  LOG[("~/.local/share/jev/events.jsonl")]
  METER["jev meter serve<br/>127.0.0.1:8788"]
  PROM["Prometheus"]
  GRAF["Grafana · Jev Impact"]

  HARNESS --> MCP
  MCP --> CLIENT
  ASK --> CLIENT
  TRIAGE & CHECK & AUDIT & LABEL --> CLIENT
  CLIENT --> API
  CLIENT --> LOG
  AUDIT & TRIAGE & LABEL --> LOG
  LOG --> METER --> PROM --> GRAF
```

Two rules keep this small:

1. **Judgment lives once.** Every MCP-capable harness connects to the same
   `jev mcp` server; `typesafe_ask` is the generic surface and task-shaped
   tools wrap question packs instead of reimplementing them (see
   [mcp.md](mcp.md#tool-surface-policy)). Local CLI commands are the other
   callers.
2. **Every judgment is logged.** The client appends to the event log before the
   answer is returned to the caller; a logging failure never fails the call.

## Call lifecycle

```mermaid
sequenceDiagram
  participant H as Harness or CLI command
  participant C as JevClient
  participant T as Transport (fetch)
  participant A as TypeSafe API
  participant L as EventLog

  H->>C: ask({ harness, state, questions, model? })
  C->>C: key present? else log error + fail JevConfigError
  C->>T: POST /v1/systemone { state, questions, model }
  T->>A: HTTPS
  A-->>T: { model, answers, usage }
  T-->>C: JSON (2xx) or typed transport failure
  C->>C: Schema-decode, map `type` → `_tag`
  C->>L: append call event (status, latency, answers, tokens)
  C-->>H: AskResult
```

Error taxonomy (`src/core/client.ts`): `JevConfigError` (no API key),
`JevTransportError` (network), `JevTimeoutError` (120s), `JevApiError`
(non-2xx, carries status), `JevDecodeError` (shape mismatch). Callers surface
these as text, never guesses.

## Core services

| Module | Service | Responsibility |
|---|---|---|
| `core/client.ts` | `JevClient` | Ask TypeSafe, map wire format (`type`) to the internal dialect (`_tag`), log every call |
| `core/events.ts` | `EventLog` | Append/read the JSONL log; malformed lines are skipped |
| `core/metrics.ts` | `serveMeter` | Read the log, render Prometheus text on `127.0.0.1:8788` |
| `core/loops.ts` | `LoopGuard` | Fingerprint failures, count repeats, prune after 24h, escalate once at the third |
| `core/detector.ts` | — | Deterministic claim patterns: live trigger + span quoting for detected claims |
| `core/text.ts` | — | `redact` (credentials), `clip`, `stripFencedCode` (prose-only state) |
| `core/transcript.ts` | — | Claude transcript parsing: `is_error` tool results, newest first |
| `core/directives.ts` | — | The prompt directive and context policy strings shared by every harness |
| `core/paths.ts` | — | Data dir, event log, loop state, harness session roots, API endpoint |

All services follow the repo conventions: class-style `Context.Service`,
`make*` constructors plus Layer factories, `Data.TaggedError` failures, and
`Effect.runPromise` only at host entrypoints (CLI `main`, MCP boundary, tests).

## Event log

One JSONL file (`JEV_DATA_DIR`, default `~/.local/share/jev`). Five kinds,
all validated by `src/core/schema.ts`:

| Kind | Fields (abridged) | Written by |
|---|---|---|
| `call` | harness, sessionID, model, latencyMs, status, questions (id+type), answers, tokens, error? | JevClient on every ask |
| `opportunity` | harness, sessionID, source, pattern, matched | `audit run` |
| `triage` | harness, feature (failure/review/commit/verify), numeric summary | triage commands, `typesafe_verify` |
| `session_label` | harness, sessionID, outcome, friction, waste, taskType | `label sessions` |
| `review` | harness, sessionID, model, dimensions (normalized score, confidence, applicable, direction?), topWeakness? | `typesafe_review` |

```mermaid
flowchart LR
  subgraph producers["Producers"]
    JC["JevClient"]
    AR["audit run"]
    TR["triage · check"]
    LS["label sessions"]
  end
  LOG[("events.jsonl")]
  subgraph consumers["Consumers"]
    METER["meter serve"]
    DASH["Grafana"]
    CLI["jev events"]
    AUD["audit alignment<br/>(call questions per session)"]
  end
  JC --> LOG
  AR --> LOG
  TR --> LOG
  LS --> LOG
  LOG --> METER --> DASH
  LOG --> CLI
  LOG --> AUD
```

Event content is summaries, counts, and answers only. Raw code, transcripts,
and secrets never enter the log, and `triage` events carry numeric summaries
only (`Schema.Record(Schema.String, Schema.Number)`).

## Judgment pattern: question pack → answers → code policy

Every feature follows the same shape:

```mermaid
flowchart LR
  INPUT["Input<br/>message · failure · finding · commit"] --> SAN["Sanitize<br/>redact · clip · strip code"]
  SAN --> STATE["State (JSON)"]
  STATE --> PACK["Question pack<br/>choice · noul · score"]
  PACK --> CALL["JevClient.ask (batched)"]
  CALL --> ANS["Answers<br/>confidence · probabilities"]
  ANS --> POLICY["Code applies documented thresholds<br/>never invents values"]
  POLICY --> OUT["Verdict · route · label · event"]
```

The model judges; code composes. Thresholds (`>= 0.5`, `>= 0.6`, severity
`>= 3`) are explicit constants with comments — they are policy, not magic.

## Audit pipeline (`jev audit run`)

```mermaid
flowchart LR
  subgraph extract["Extract messages"]
    OC["opencode2 DB<br/>session_message"]
    CC["~/.claude/projects"]
    PO["pi / omp session logs"]
  end
  OC & CC & PO --> PROSE["Prose only<br/>stripFencedCode → redact → clip 1000"]
  PROSE --> DET["Detection batches (20)<br/>m_noul route? + m_kind choice"]
  DET --> CONFIRMED["Detected claims<br/>route ≥ 0.5 and kind ≠ none"]
  CONFIRMED --> SPAN["Span quoting<br/>regex finds the matched text"]
  SPAN --> ALIGN["Alignment batches (20)<br/>vs session call questions"]
  ALIGN --> EV["opportunity events<br/>matched true/false"]
  EV --> SUM["Summary: messages · detected · matched · compliance"]
```

`jev audit prompts` reuses detection with the `user_prompt` subject to measure
the live trigger: how many prompts the local regex tags versus how many Jev
would route, with examples of both disagreements.

## Failure triage and the loop breaker

```mermaid
flowchart TD
  F["Failure text<br/>--text · --transcript · stdin"] --> CAND{"Transcript?<br/>several error snippets"}
  CAND -->|"several"| SEL["Jev selection: which snippet is the failure"]
  CAND -->|"1"| FP
  SEL --> FP["fingerprint: sha256 of normalized text"]
  FP --> RECENT["recent(5) sampled failures"]
  RECENT --> HIT{"exact fingerprint<br/>in recent?"}
  HIT -->|yes| CHECK
  HIT -->|no| IDENT["Jev identity: same as recent_i or none?"]
  IDENT --> CHECK["LoopGuard.check(canonical fp, sample)"]
  CHECK --> THIRD{"count >= 3<br/>and not escalated?"}
  THIRD -->|yes| ESC["ESCALATE once<br/>fix root cause or suppress explicitly"]
  THIRD -->|no| CLASS["Jev class · blocks_work · safe_to_suppress"]
  ESC --> CLASS
  CLASS --> EVT["triage event (numeric summary)"]
```

The loop breaker is the only suppression path in the system and it fires
exactly once per fingerprint (24h window). State lives in
`loop-state.json`, written atomically.

## Privacy boundary

```mermaid
flowchart LR
  RAW["Raw text<br/>code · transcripts · secrets"] --> STRIP["stripFencedCode<br/>raw code never leaves"]
  STRIP --> RED["redact<br/>Authorization headers<br/>*_TOKEN/_KEY/_SECRET"]
  RED --> CLIP["clip<br/>1000-2000 chars, marked"]
  CLIP --> STATE["Jev state"]
  RAW --> LOCAL[("local event log<br/>summaries only")]
```

- `TYPESAFE_API_KEY` is read at call time; never logged, never persisted.
- Automated flows (`audit`, `label`, `triage`, `check`, hooks) mask credentials
  (bare or quoted Authorization/API-key fields, `*_TOKEN`/`*_KEY`/`*_SECRET`/
  `*_PASSWORD` assignments, Bearer tokens) and replace fenced code blocks with
  `[code]` before state is sent.
- Direct callers (`jev ask`, MCP `typesafe_ask`) own their state; the client
  sends it as provided and does not redact for them.
- Triage events store counts, not text; `session_label` stores enum labels.
- Tests are offline: fake transports, temp dirs, `127.0.0.1` only, no module
  mocking.

## Design rules

- **Effect everywhere in core.** `Effect.Effect` returns, `Data.TaggedError`
  failures, services via `Context.Service` + Layers. Platform APIs (`fetch`,
  `node:fs`, `node:sqlite`) are wrapped at the boundary once.
- **Schema at every boundary.** JSONL lines, API responses, stdin payloads,
  transcripts, git output. Malformed input is skipped or failed explicitly.
- **Log-first.** New triggers observe and record before they gate; only the
  loop breaker (and future secret traps) may suppress, and only after their
  fixtures pass.
