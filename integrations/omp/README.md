# jev-toolkit for OMP

Native OMP package with two parts:

- **Prompt recall** — a `before_agent_start` extension (`index.ts`) that
  appends the Jev directive to the system prompt when the prompt asks for a
  quantitative judgment. Non-blocking and silent otherwise.
- **Skill** — `SKILL.md` teaches the agent when and how to call the mounted
  `typesafe_ask` tool, with `jev ask` as the fallback.

OMP reads the `pi` manifest in the repository's root `package.json`, so the
registration is the same file Pi loads: OMP vendors the Pi extension API.
`index.ts` only re-exports `../pi/index.ts` because extension discovery happens
through a linked path.

## Requires

`jev` on `PATH` (`scripts/install.sh`) and the `jev` MCP server mounted in
`~/.omp/agent/mcp.json`:

```json
"jev": {
  "type": "stdio",
  "command": "jev",
  "args": ["mcp"],
  "env": { "JEV_HARNESS": "omp" },
  "timeout": 120000,
  "enabled": true
}
```

## Install

```console
omp plugin install /path/to/jev-toolkit   # the clone
omp plugin list --json   # jev-toolkit must list the extension and skill
omp plugin doctor        # must report no load errors
```

Restart OMP after install. If a `jev-prompt-recall` symlink exists in
`~/.omp/agent/extensions`, remove it after install — two registrations inject
the directive twice:

```console
rm ~/.omp/agent/extensions/jev-prompt-recall
```

## Verify

Run one prompt that asks for a judgment; the model should call the Jev tool and
report its answer:

```console
omp -p --no-title "which option is best, A versus B?"
```

## Uninstall

```console
omp plugin uninstall jev-toolkit
```

## Privacy

The extension only reads the prompt and edits the system prompt. Nothing leaves
the machine except the `typesafe_ask` state you send yourself; calls are logged
locally in `~/.local/share/jev/events.jsonl`.
