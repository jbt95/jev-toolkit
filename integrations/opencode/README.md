# Jev for OpenCode V2

Native prompt recall plus typed skill-routing guidance. Zero runtime
dependencies: `index.ts` is loaded directly by OpenCode.

## What it does

- `index.ts` — native plugin with two hooks sharing one recall prefilter:
  - `prompt`: when the incoming user text asks for a routed judgment, append a
    task-specific echo to the prompt itself. End-append only, so attachment
    mention offsets are unaffected; skipped when already present, so retried
    admissions never duplicate it. This addresses the observed failure mode
    where the model explores the code and then treats its derived
    recommendation as a lookup rather than a judgment.
  - `context`: before each agent-loop model call, push the Jev directive onto
    `system` when the latest user text matches. Only the outgoing call is
    affected; persisted history is never rewritten. Auxiliary requests
    (`title`, `compaction`, `generate`) are skipped.
- `jev-routing.md` — versioned source of the static routing instruction.
  Install a copy to `~/.config/opencode/instructions/jev-routing.md` so every
  session carries the policy even before the hooks fire.

The recall patterns mirror `src/core/detector.ts` (and
`integrations/pi/index.ts`); agreement between the copies is pinned by
`tests/integrations/opencode-plugin.test.ts`.

## Install

```console
jev install opencode
```

The command copies the managed plugin and instruction files and idempotently
adds their entries to the global OpenCode config. It honors
`XDG_CONFIG_HOME`; restart OpenCode after installing. If either managed file
already exists with different content, the command stops instead of overwriting
it; use `jev install opencode --force` when replacement is intentional.

The installer adds these entries. If you configure the integration manually,
use a file-level plugin entry (not a directory-level entry) and keep the
instructions entry in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": ["./plugins/jev/index.ts"],
  "instructions": ["AGENTS.md", "instructions/jev-routing.md"],
}
```

Restart the background service and confirm with a real run — the only
reliable check, since `plugin list` does not show every loaded plugin:

```console
opencode service restart
opencode run "what should be the best approach to implement this ticket"
```

The first judgment tool call in a session should be a Jev tool via the `jev`
MCP server. Use `typesafe_skill_route` when choosing among skills and
`typesafe_ask` for other judgments. `jev hook prompt` remains available for
harnesses with a prompt hook; it uses the same detector.

## Uninstall

Remove the `plugins` entry and `~/.config/opencode/plugins/jev`, and delete
the instructions file plus its entry to end the test.
