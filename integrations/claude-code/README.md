# jev-toolkit for Claude Code

Plugin with three parts:

- **MCP tool** — the plugin declares the `jev` MCP server (`jev mcp`): one
  `typesafe_ask` tool for probabilities, rankings, choices, and graded
  estimates. No per-harness tool code; the tool arrives with the session.
- **Prompt trigger** — a `UserPromptSubmit` hook that injects the Jev
  directive when a quantitative question is detected.
- **Skill** — `skills/jev/SKILL.md` teaches the agent when and how to call the
  tool, with the `jev ask` CLI as fallback.

## Requires

`jev` on `PATH` — install with `~/personal/jev-toolkit/scripts/install.sh`. The
hook is silent when `jev` is absent; the MCP server reports a config error when
`TYPESAFE_API_KEY` is missing.

## Install

```console
claude plugin marketplace add ~/personal/jev-toolkit
claude plugin install jev-toolkit@jev-toolkit
claude plugin list
```

Restart Claude Code so the hook and MCP server are picked up. Re-run
`claude plugin install` after manifest changes — the plugin cache copies files
at install time.

Keep one wiring per hook: if `~/.claude/settings.json` already runs
`jev hook prompt` on `UserPromptSubmit`, remove that entry — the plugin hook
would inject the directive a second time. The same applies to the `jev` MCP
server: with the plugin installed, `~/.claude.json` must not declare a second
`jev` server.

## What ships

- `.claude-plugin/plugin.json` — MCP server declaration (`mcpServers.jev` →
  `jev mcp`, `JEV_HARNESS=claude-code`).
- `hooks/hooks.json` — `UserPromptSubmit` → `jev hook prompt`: prints the Jev
  directive only when a quantitative-intent pattern matches; never blocks.
  `Stop` → `jev triage failure`: prints the failure classification only when it
  blocks work or the loop breaker escalates.
- `skills/jev/SKILL.md` — when and how to call `typesafe_ask`.

## Uninstall

```console
claude plugin uninstall jev-toolkit@jev-toolkit
claude plugin marketplace remove jev-toolkit
```

## Privacy

Only what you pass in `state` reaches TypeSafe; keep secrets and raw
credentials out. Calls are logged locally in `~/.local/share/jev/events.jsonl`.
