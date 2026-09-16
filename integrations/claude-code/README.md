# jev-toolkit for Claude Code

Thin plugin around the `jev` CLI: a `UserPromptSubmit` hook that injects the
Jev directive when a prompt asks for a quantitative judgment, plus the `jev`
skill that teaches the agent when and how to call `jev ask`.

## Requires

`jev` on `PATH` — install it with `~/personal/jev-toolkit/scripts/install.sh`
(linked into `~/.local/bin`). The hook is silent when `jev` is absent.

## Install

```console
claude plugin marketplace add ~/personal/jev-toolkit
claude plugin install jev-toolkit@jev-toolkit
claude plugin list
```

Restart Claude Code so the hook is picked up.

## What ships

- `hooks/hooks.json` — `UserPromptSubmit` → `jev hook prompt`: prints the Jev
  directive only when a quantitative-intent pattern matches; never blocks.
- `skills/jev/SKILL.md` — when and how to run `jev ask`, output format, and the
  privacy rules.

## Uninstall

```console
claude plugin uninstall jev-toolkit@jev-toolkit
claude plugin marketplace remove jev-toolkit
```

## Privacy

Only what you pass in `state` reaches TypeSafe; keep secrets and raw
credentials out. Calls are logged locally in `~/.local/share/jev/events.jsonl`.
