# Harness wiring (Jev decision layer)

One server, one contract, four tags. `command: jev`, `args: ["mcp"]` everywhere.

| Harness | JEV_HARNESS | Routing source |
|---|---|---|
| opencode | `opencode2` | `~/.config/opencode/instructions/jev-routing.md` |
| claude-code | `claude-code` | `~/.claude/CLAUDE.md` ("Jev decision routing") |
| pi | `pi` | pi skill routing (mirror of `jev-routing.md`) |
| omp | `omp` | omp skill routing (mirror of `jev-routing.md`) |

Rules: `typesafe_ask` before any number/ordering/selection; quote verdict + confidence + "from Jev"; `<0.4` = no signal; API failure = unavailable + qualitative fallback. `typesafe_verify` for publishable claims, `typesafe_review` for change reviews. Audit: `jev audit run --harness all|opencode2|claude-code|pi|omp --dry-run`.
