# AGENTS.md — working rules for jev-toolkit

## Stack

- Runtime dependency: **`effect` 4.0.0-rc.112 only**, pinned exactly (mirrors
  `~/personal/creatorOS`). Everything else is a devDependency:
  `typescript` 5.9.2, `@types/node` 22.18.0, `vitest` 3.2.4, `oxlint` 1.81.0,
  `@oxlint/plugins` 1.81.0, `oxfmt` 0.66.0. Harness SDKs are devDependencies
  of their integration folders only.
- TypeScript strict, ESM, explicit `.ts` extensions
  (`allowImportingTsExtensions`), `verbatimModuleSyntax`, `isolatedModules`.
  No build step. Node >= 26.
- Import paths: source under `src/` uses relative imports (the CLI runs on
  plain Node, which ignores tsconfig paths). Tests and the OpenCode2 plugin
  may use `@/…` (vitest alias / Bun tsconfig paths). Pi/OMP extensions must
  use relative imports — jiti does not resolve `@/` paths (verified
  2026-09-17).

## Effect rules (mirror ~/personal/creatorOS)

- Core code returns `Effect.Effect`, not `Promise`/`async`. Wrap unavoidable
  platform APIs (`fetch`, `node:fs`, `node:http`, `node:sqlite`,
  `node:child_process`) with `Effect.tryPromise`/`Effect.try` and convert
  failures to typed errors at that boundary. `Effect.runPromise` only at host
  entrypoints (CLI `main`, plugin/hook boundaries) and tests.
- Services: class-style `Context.Service` with exported `make*` constructors
  and Layer factories. Runtime code yields services from context; **only tests
  and composition roots import `make*`**
  (`anti-slop-effect/no-service-constructor-imports`).
- Errors: `Data.TaggedError` subclasses
  (`class XError extends Data.TaggedError("XError")<{ readonly … }> {}`) so
  failures are tag-matchable; `return yield* Effect.fail(new XError({ … }))`.
  `Schema.TaggedError` only when the error crosses an encoding/API boundary.
  No `try/catch` inside `Effect.gen`, no `catchAllCause` for mapping, no silent
  error swallowing.
- Time via `Clock.currentTimeMillis`, never `Date.now()`.

## Schema rules

- Decode at boundaries with Effect Schema: JSONL event lines, TypeSafe API
  responses, stdin payloads, transcripts, findings, git output, digests.
  Malformed input is skipped or failed explicitly — never coerced.
- No `Record<string, unknown>` (typed `Record<string, T>` domain maps are
  fine), no `unknown` parameters/returns, no broad `object` params, no runtime
  `typeof` narrowing. Every `as` needs a `// SAFETY:` comment
  (anti-slop/require-safety-comment-for-type-assertion).

## Tooling gates

- All four green before every commit: `npm run lint` (oxlint + vendored
  anti-slop generic and Effect rule groups), `npm run format:check` (oxfmt),
  `npm run typecheck` (tsc), `npm test` (vitest).
- Tests are offline: fake services/transports, temp dirs, `127.0.0.1` only.
  Never call `api.typesafe.ai` in tests. No module mocking (`vi.mock` banned)
  — inject services and functions instead.
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
