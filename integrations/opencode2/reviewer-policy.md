# Reviewer triage policy

When you finish a code review, emit findings as JSON and let Jev triage them
instead of arguing severity in prose.

1. Write findings to a file:

   ```json
   {
     "findings": [
       {
         "id": "f1",
         "title": "Missing null check in handler",
         "detail": "The handler dereferences user.profile without checking for null.",
         "file": "src/handler.ts",
         "line": 42
       }
     ]
   }
   ```

2. Run the triage:

   ```console
   jev triage review --input findings.json
   ```

3. Act on the routed output:

   - `blockers` — fix before shipping.
   - `cosmetic` — append to the review notes or the cosmetic ledger; do not
     start a fix round for them.
   - `questions` — ask for evidence or clarify (Jev confidence was below 0.6,
     or the class answer said "question").
   - `truncated: true` — the review read as cut off; continue it once before
     concluding.
   - `reviewSubstantive: false` — the review restated the summary instead of
     examining the diff; rewrite it against the actual changes.

Rules: one finding per issue; specific titles; cite files and lines where
possible. The triage is a judgment aid — you remain responsible for the
verdict.
