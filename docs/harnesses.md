# Harness wiring (Jev decision layer)

One server, one contract, four tags. `command: jev`, `args: ["mcp"]` everywhere.

| Harness | JEV_HARNESS | Routing source | Prompt recall |
|---|---|---|---|
| opencode | `opencode` | `~/.config/opencode/instructions/jev-routing.md` (versioned source: `integrations/opencode/jev-routing.md`) | native plugin `integrations/opencode/index.ts` → `session.hook("context")` injects the directive into the outgoing call when the recall prefilter matches (zero-dep, verified live) |
| claude-code | `claude-code` | `~/.claude/CLAUDE.md` ("Jev decision routing") | CLAUDE.md routing section (proven by an observed `typesafe_ask` call) |
| pi | `pi` | pi skill routing (mirror of `jev-routing.md`) | `before_agent_start` extension `~/.pi/agent/extensions/jev-prompt-recall` → `integrations/pi/index.ts` (verified live: `choice` call logged with `harness=pi`) |
| omp | `omp` | omp skill routing (mirror of `jev-routing.md`) | `before_agent_start` extension `~/.omp/agent/extensions/jev-prompt-recall` → same `integrations/pi/index.ts`, OMP vendors the Pi API (verified live: `choice` call logged with `harness=omp`) |

Rules: `typesafe_ask` before any number/ordering/selection; quote verdict + confidence + "from Jev"; `<0.4` = no signal; API failure = unavailable + qualitative fallback. `typesafe_verify` for publishable claims, `typesafe_review` for change reviews. Audit: `jev audit run --harness all|opencode|claude-code|pi|omp --dry-run`.

Pi direct tools: register the jev server's tools first-class with
`"directTools": true` on its `~/.pi/agent/mcp.json` entry. Through the generic
`mcp` proxy the tool arguments travel as an escaped JSON string — a 2026-09-18
pi session (leadline Go support) lost 3 of 4 `typesafe_ask` attempts to
malformed `args` payloads and only succeeded after shrinking the call. Direct
tools take typed object arguments and skip the search/describe round trips.
Tools register from `~/.pi/agent/mcp-cache.json`; `/mcp reconnect jev` forces a
refresh if one is missing.

Known gaps: pi/omp calls carry no harness session id (the adapter does not
inject one). `src/audit/attribution.ts` recovers the link offline instead: it
reads the assistant turn that issued the call from the session files
(`loadPiOmpTurns`) and matches the call's question ids against it, crediting
both the issuing session and, when the session records `parentSession`, the
parent it was spawned from. Verified against the live log: 24 of 33 omp calls
resolve to their session; the rest are `jev triage` runs that inherited
`JEV_HARNESS=omp` from the shell and have no transcript turn to match.

