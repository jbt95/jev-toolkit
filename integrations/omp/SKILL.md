---
name: jev
description: Deterministic Jev/TypeSafe judgments (probabilities, rankings, choices, graded estimates) through the jev MCP mount. Use before writing any quantitative judgment in an answer.
---

# jev

The `jev` MCP server gives you calibrated, structured answers from
TypeSafe/Jev — a System One decision model — instead of guessing numbers. One
call: send state plus typed questions, get probabilities back.

## When to call

Call before writing: probabilities and likelihoods, rankings and priorities,
choices among named alternatives, and graded estimates (severity, risk,
quality, relevance, difficulty). Skip it for exact arithmetic, lookups, or
trivia with no decision attached.

## How to call

In OMP the tool is mounted as a device: write the JSON arguments to
`xd://mcp__jev_typesafe_ask` (read `xd://mcp__jev_typesafe_ask` first for its
schema). Arguments: `{ "state": ..., "questions": {...}, "model": "..." }`.

- `state` — text or structured JSON to evaluate.
- `questions` — map of id to question:
  - `{ "_tag": "choice", "instructions": "...", "criteria": { "option_a": "...", "option_b": "..." } }`
  - `{ "_tag": "noul", "instructions": "..." }` (optional `criteria` map for true/false meaning)
  - `{ "_tag": "score", "instructions": "...", "criteria": ["level0", "level1", "level2"] }`

The result is text like:

```
jev jev-1.13.0
q_id: p(yes)=0.99
usage: 279 in / 22 out
```

Ask independent questions in one call; keep one coherent judgment per question.

Fallback when the mount is unavailable: pipe the same JSON to `jev ask`:

```console
printf '%s' '{"state":"<text or JSON>","questions":{"q_id":{"_tag":"noul","instructions":"..."}}}' | jev ask
```

## Rules

- Report the tool's answer with its probability/confidence and say it came from
  Jev. Never present a Jev number as your own estimate.
- If the call fails, say the judgment is unavailable and fall back to an
  explicit qualitative answer — never invent a number.
- Keep secrets, credentials, and raw proprietary code out of `state`; send only
  what the judgment needs.
- Calls are logged locally (`~/.local/share/jev/events.jsonl`) and measured on
  the Jev Impact dashboard.
