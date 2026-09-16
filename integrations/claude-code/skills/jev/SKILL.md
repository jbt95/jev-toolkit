---
name: jev
description: Deterministic Jev/TypeSafe judgments (probabilities, rankings, choices, graded estimates) via the `jev` CLI. Use before writing any quantitative judgment in an answer.
---

# jev

`jev` gives you calibrated, structured answers from TypeSafe/Jev — a System
One decision model — instead of guessing numbers. One call: send state plus
typed questions, get probabilities back.

## When to call

Call `jev ask` before writing: probabilities and likelihoods, rankings and
priorities, choices among named alternatives, and graded estimates (severity,
risk, quality, relevance, difficulty). Skip it for exact arithmetic, lookups,
or trivia with no decision attached.

## How to call

```console
printf '%s' '{"state":"<text or JSON>","questions":{"q_id":{"_tag":"noul","instructions":"..."}}}' | jev ask
```

Question primitives (map of id to question):

- `{"_tag":"choice","instructions":"...","criteria":{"option_a":"...","option_b":"..."}}`
- `{"_tag":"noul","instructions":"..."}` (optional `criteria` map for true/false meaning)
- `{"_tag":"score","instructions":"...","criteria":["level0","level1","level2"]}`

The output looks like:

```
jev jev-1.13.0
q_id: p(yes)=0.99
usage: 279 in / 22 out
```

Ask independent questions in one call; keep one coherent judgment per question.

## Rules

- Report the tool's answer with its probability/confidence and say it came from
  Jev. Never present a Jev number as your own estimate.
- If the call fails, say the judgment is unavailable and fall back to an
  explicit qualitative answer — never invent a number.
- Keep secrets, credentials, and raw proprietary code out of `state`; send only
  what the judgment needs.
- Calls are logged locally (`~/.local/share/jev/events.jsonl`) and measured on
  the Jev Impact dashboard.
