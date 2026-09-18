# Jev for OpenCode V2

Native prompt recall plus static routing. Zero dependencies: `index.ts` has no
imports, so no install step is needed.

## What it does

- `index.ts` — native plugin. Registers a `context` session hook that scans
  the latest user text before each agent-loop model call and pushes the Jev
  directive onto `system` when the recall prefilter matches. Only the outgoing
  call is affected; persisted history is never rewritten. Auxiliary requests
  (`title`, `compaction`, `generate`) are skipped.
- `jev-routing.md` — versioned source of the static routing instruction.
  Install a copy to `~/.config/opencode/instructions/jev-routing.md` so every
  session carries the policy even before the hook fires.

The recall patterns mirror `src/core/detector.ts` (and
`integrations/pi/index.ts`); agreement between the copies is pinned by
`tests/integrations/opencode-plugin.test.ts`.

## Telemetry

Every fire appends one JSONL line to `hook-fires.jsonl` next to the event log
(`~/.local/share/jev/`, or `$JEV_DATA_DIR` when set):

```jsonc
{
  "ts": "…",
  "sessionID": "ses_…",
  "pattern": "ranking",
  "excerpt": "what should be the best approach…",
  "directivePushed": true,
}
```

Compare hook demand against actual calls to separate the two failure modes:

```console
wc -l ~/.local/share/jev/hook-fires.jsonl  # prompts the hook flagged
jev events --harness opencode               # calls the model actually made
```

Fires without calls mean the model saw the directive and skipped it;
no fires mean the hook never matched. Logging is best-effort and never
throws, so telemetry can never break a model call.

## Install

```console
mkdir -p ~/.config/opencode/plugins/jev ~/.config/opencode/instructions
cp integrations/opencode/index.ts ~/.config/opencode/plugins/jev/index.ts
cp integrations/opencode/jev-routing.md ~/.config/opencode/instructions/jev-routing.md
```

Add the plugin entry (file-level, not directory-level) and keep the
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

The first tool call in the session should be a Jev `typesafe_ask` (via the
`jev` MCP server). `jev hook prompt` remains available for harnesses with a
prompt hook; it uses the same detector.

## Uninstall

Remove the `plugins` entry and `~/.config/opencode/plugins/jev`, and delete
the instructions file plus its entry to end the test.
