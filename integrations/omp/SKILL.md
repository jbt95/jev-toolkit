---
name: jev
description: Deterministic Jev/TypeSafe judgments through the jev MCP mount, with typesafe_skill_route for skill selection. Use before writing quantitative judgments or choosing skills in an answer.
---

# jev

The `jev` MCP server gives you calibrated, structured answers from
TypeSafe/Jev — a System One decision model — instead of guessing numbers. Use
`typesafe_ask` for general judgments and `typesafe_skill_route` when choosing
skills from a candidate catalog.

## When to call

Call `typesafe_ask` before writing: probabilities and likelihoods, rankings and
priorities, choices among named alternatives, and graded estimates (severity,
risk, quality, relevance, difficulty). For choosing which skills to load, call
`typesafe_skill_route` instead. Skip both tools for exact arithmetic, lookups,
or trivia with no decision attached.

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

### Skill routing

When selecting skills, read `xd://mcp__jev_typesafe_skill_route` first for its
schema, then write the task and every candidate skill that could apply. Pass
each candidate's name and description; the tool cannot choose an omitted
candidate. Load only the skill or ordered skill chain returned by Jev. A
generic recommendation about skills is not a route event.

For skill routing without the mount, use `jev route skills --task TEXT
--skills-dir DIR` with the candidate catalog. Do not substitute `jev ask`.

Fallback for a general judgment when the mount is unavailable: pipe the same
JSON to `jev ask`:

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
