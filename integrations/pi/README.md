# jev-toolkit for Pi

Native Pi extension with one tool and one trigger:

- **`typesafe_ask`** — calibrated TypeSafe/Jev judgments (`choice`, `noul`,
  `score`) over a text or JSON state. The extension is a self-contained shim:
  every judgment delegates to the `jev` CLI, so there is no `effect` import,
  no repo-relative import, and nothing to install locally.
- **Input transform** — appends the Jev directive when a quantitative question
  is detected in your prompt (via `jev hook prompt`).

All calls are logged to `~/.local/share/jev/events.jsonl` (harness `pi`) and
exposed as Prometheus metrics by `jev meter serve`.

## Install (development)

```console
ln -sfn ~/personal/jev-toolkit/integrations/pi ~/.pi/agent/extensions/jev
```

Restart Pi and confirm `typesafe_ask` is listed as an available tool.
`typebox` resolves from Pi's shared extensions `node_modules`; the extension
has no dependencies to install itself. `jev` must be on `PATH`
(`~/personal/jev-toolkit/scripts/install.sh`).

## Install (packaged)

```console
pi install /path/to/jev-toolkit/integrations/pi
```

## Uninstall

```console
pi remove /path/to/jev-toolkit/integrations/pi
# or remove the symlink
```

## Notes

- `TYPESAFE_API_KEY` must be visible to the Pi process; the tool reports a
  config error when it is missing (never a made-up number).
- OMP vendors the Pi extension API; see `integrations/omp` for the OMP
  package. OMP installs set `JEV_HARNESS=omp` so events carry the right
  harness id.
- State sent in a call leaves the machine — keep secrets out of `state`.
