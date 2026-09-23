# MCP server (`jev mcp`)

The server exposes three judgment tools over stdio:

- `typesafe_ask` — a focused typed judgment (`choice`, `noul`, or `score`).
- `typesafe_rank` — order a caller-supplied shortlist by relevance to a query.
- `typesafe_verify` — check claims against caller-supplied evidence.

Use **ask** for a judgment or choice, **rank** to order explicit candidates,
and **verify** to check claims against evidence. Ranking is not verification: a
high relevance score does not establish that a candidate's claims are true.
The initialize response advertises this routing policy; MCP hosts should pass
server instructions and tool descriptions into the model context.

## Install into a harness

With Bun >= 1.3.14 installed, run `bun install` and `scripts/install.sh`, then run one of:

```console
jev install opencode
jev install pi
jev install omp
jev install claude-code
```

- `jev install opencode` updates `~/.config/opencode/opencode.json` (`mcp`),
  preserving other settings and JSONC comments.
- `jev install pi` installs `pi-mcp-adapter` with
  `pi install npm:pi-mcp-adapter`, then updates `~/.config/mcp/mcp.json`
  (`mcpServers`). Pi and network access are required for the adapter install.
- `jev install omp` updates `~/.omp/agent/mcp.json` (`mcpServers`) using OMP's
  stdio server format.
- `jev install claude-code` registers a user-scoped server with the `claude`
  CLI. It replaces only an existing user-scoped `jev-toolkit` entry.

All targets launch the server from the current Jev checkout using Bun, set
`JEV_HARNESS` appropriately, and preserve unrelated server entries. Rerun the
command if you move the checkout. Restart clients that were already running.
The installer never writes `TYPESAFE_API_KEY`; ensure the harness process passes
that variable to the server. Other clients can configure `command: jev` and
`args: ["mcp"]` manually. Valid `JEV_HARNESS` values are `opencode`,
`claude-code`, `pi`, `omp`, `cli`, and `script`.

## Protocol

The server supports `initialize`, `ping`, `tools/list`, and `tools/call` over
newline-delimited JSON-RPC 2.0. Notifications are acknowledged without a
response. Tool failures are returned as text content with `isError: true`;
malformed requests and unknown tools use JSON-RPC errors.

Nested `questions`, `claims`, and `candidates` may be passed as their normal
JSON value or as a JSON-encoded string, then are schema-validated either way.

## `typesafe_ask`

```json
{
  "state": "The export must choose one backend.",
  "questions": {
    "decision": {
      "_tag": "choice",
      "instructions": "Which backend should we choose?",
      "criteria": { "csv": "Simple tabular output", "xlsx": "Workbook formatting required" }
    }
  },
  "sessionID": "optional-exact-harness-session-id"
}
```

`state` accepts JSON values. `questions` maps ids to one of:

```jsonc
{ "_tag": "choice", "instructions": "…", "criteria": { "option": "description" } }
{ "_tag": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } }
{ "_tag": "score", "instructions": "…", "criteria": ["low", "medium", "high"] }
```

`model` is optional and defaults to `jev-latest`. The answer includes the
model, formatted answers, confidence where applicable, and token usage. Choice
and score confidence below 0.4 is flagged as no signal; a Noul value is the
probability of yes.

## `typesafe_rank`

```json
{
  "query": "Which excerpt best supports that the API retries after a timeout?",
  "candidates": [
    { "id": "retry-doc", "text": "Timeouts are retried up to three times." },
    { "id": "cache-doc", "text": "Responses are cached for five minutes." }
  ],
  "sessionID": "optional-exact-harness-session-id"
}
```

Pass 1–20 candidates with unique ids; combined query and candidate text is
limited to 40,000 characters. Jev scores each candidate and the server returns
descending relevance probabilities, preserving input order for ties. Scores
are per-candidate (not normalized across the list) and are not evidence of
factual support. The tool returns JSON with `model`, `ranking` (`id` and
`relevance`), a score-interpretation note, and token `usage`. This tool ranks
only the supplied shortlist; it does not retrieve candidates. Common code,
diff, and transcript patterns are rejected before sending; these conservative
checks are not a complete content classifier. Credentials are redacted before
query and candidate text is sent. The text result contains JSON like:

```json
{
  "model": "jev-latest",
  "ranking": [{ "id": "retry-doc", "relevance": 0.91 }],
  "note": "Per-candidate relevance probabilities, not normalized across the list...",
  "usage": { "input": 120, "output": 4 }
}
```

## `typesafe_verify`

```json
{
  "claims": [{ "id": "tests", "text": "All 12 tests pass" }],
  "evidence": "test output: 12 passed, 0 failed",
  "sessionID": "optional-exact-harness-session-id"
}
```

Claims are judged as `supported`, `contradicted`, `unrelated`, or `insufficient`.
The tool also reports claim numbers absent from the evidence and flags weak
verdicts for follow-up. It accepts 1–20 claims and at most 40,000 evidence
characters. Credentials are redacted before sending; claim and evidence text
are never logged. Only numeric verdict summaries are appended to the local
event log.

## Logging and privacy

Calls are logged locally with harness, session id, question ids and types,
answer, usage, latency, and typed status. Raw ask state and question text are
not logged. `typesafe_ask` sends caller-provided state as supplied, so callers
must redact it. `typesafe_rank` rejects common code, diff, and transcript
patterns, redacts credentials before sending, and logs no query, candidate
text, or candidate ids. The pattern checks are not a complete content classifier.
`typesafe_verify` redacts credentials and does not log its claims or evidence.
`TYPESAFE_API_KEY` is read at call time and never logged.
