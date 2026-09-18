# Jev decision routing (test mode)

While this file is installed and listed under `instructions` in
`opencode.json`, every quantitative judgment goes through the `typesafe_ask`
tool before it is written down. This is a deliberate test phase: do not
estimate, hedge, or reason out a number first.

In scope — anything that is, or feeds, a number, an ordering, or a selection
that affects a decision:

- probabilities, likelihoods, and probabilistic guesses;
- rankings, priorities, and comparisons;
- choices among named alternatives (routing, classification, triage);
- graded estimates (severity, risk, quality, relevance, difficulty).

Implementation approach is in scope. These are all choices among named
alternatives and must each go through `typesafe_ask` before you recommend one:

- backend vs frontend generation, GET vs POST, library A vs library B;
- streaming vs in-memory workbook, Java-sort vs SQL-sort, sync vs async;
- any "best approach / which option / how should we design" answer.

Rules:

- Call `typesafe_ask` before writing the judgment.
- Ask independent questions in one call; one coherent judgment per question.
- Report the tool's answer with its probability or confidence, and say it came
  from Jev. Never present the number as your own guess.
- If the API fails, say the judgment is unavailable and fall back to an
  explicit qualitative answer — never a made-up number.
- Exact arithmetic, deterministic calculations, and lookups stay in code; only
  uncertainty and semantic judgment go to Jev.
- Trivia with no decision attached needs no call.

Every call is logged to `~/.local/share/jev/events.jsonl` for
review. Delete this file and its `instructions` entry to end the test.
