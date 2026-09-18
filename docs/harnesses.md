# Harness wiring (Jev decision layer)

One server, one contract, four tags. `command: jev`, `args: ["mcp"]` everywhere.

| Harness | JEV_HARNESS | Routing source | Prompt recall |
|---|---|---|---|
| opencode | `opencode` | `~/.config/opencode/instructions/jev-routing.md` | none — plugin V2 API has no prompt event; `jev hook prompt` fires standalone but is installed on zero harnesses |
| claude-code | `claude-code` | `~/.claude/CLAUDE.md` ("Jev decision routing") | CLAUDE.md routing section (proven by an observed `typesafe_ask` call) |
| pi | `pi` | pi skill routing (mirror of `jev-routing.md`) | `before_agent_start` extension `~/.pi/agent/extensions/jev-prompt-recall` → `integrations/pi/index.ts` (verified live: `choice` call logged with `harness=pi`) |
| omp | `omp` | omp skill routing (mirror of `jev-routing.md`) | `before_agent_start` extension `~/.omp/agent/extensions/jev-prompt-recall` → same `integrations/pi/index.ts`, OMP vendors the Pi API (verified live: `choice` call logged with `harness=omp`) |

Rules: `typesafe_ask` before any number/ordering/selection; quote verdict + confidence + "from Jev"; `<0.4` = no signal; API failure = unavailable + qualitative fallback. `typesafe_verify` for publishable claims, `typesafe_review` for change reviews. Audit: `jev audit run --harness all|opencode|claude-code|pi|omp --dry-run`.
