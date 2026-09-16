# AGENTS.md — working rules for jev-toolkit

## Engineering rules

- TypeScript strict, ESM, **no runtime dependencies** — Node built-ins only
  (`node:fs`, `node:http`, `node:sqlite`, global `fetch`). Harness SDKs
  (`@opencode/plugin`, `@earendil-works/pi-coding-agent`, `typebox`) are
  devDependencies for types only; harness runtimes provide them.
- Node >= 26. Relative imports use explicit `.ts` extensions
  (`allowImportingTsExtensions`); no build step.
- Tests: `node --test` (`npm test`). Tests are offline — local HTTP servers
  and temp dirs only, never `api.typesafe.ai`. Mock via injected `fetchImpl`.
- Typecheck: `npm run check` (`tsc -p tsconfig.json`). Both gates green before
  any commit.
- Deletion over addition. Shortest working diff wins. No unrequested
  abstractions.
- Commits per task, local only. **Never push.**

## Privacy rules

- `TYPESAFE_API_KEY` is read from the environment at call time; never logged,
  never written to disk by this repo, never embedded in events.
- Event log content: summaries, counts, masked values only. Raw code, diffs,
  transcripts, secrets, and credentials never go into Jev state or events.
- Secret-scanner candidates keep raw values local (masked features only).

## Enforcement philosophy

Log-first. New triggers observe and record before they ever block or suppress
anything; only the loop breaker and secret traps may suppress, and only after
their fixtures pass.
