# jev-toolkit for OMP

OMP vendors the Pi extension API, so this package re-exports the Pi extension
(`../pi/index.ts`): one registration serves both harnesses. The extension is a
self-contained shim over the `jev` CLI — `typesafe_ask` runs `jev ask`, and the
input trigger runs `jev hook prompt`.

## Install

```console
omp plugin install ~/personal/jev-toolkit
omp plugin doctor
```

`omp plugin doctor` must report a `pi` manifest and no load errors.
`JEV_HARNESS=omp` is set by the extension itself, so calls are logged with
`harness: "omp"`.

## Requires

- `jev` on `PATH` (`~/personal/jev-toolkit/scripts/install.sh`).
- `typebox` — provided by OMP's shared extension runtime.

## Uninstall

```console
omp plugin uninstall jev-omp
```

## Notes

- The tool and trigger delegate to the `jev` CLI; no `effect` import, no
  module-graph coupling with the repo.
- State sent in a call leaves the machine — keep secrets out of `state`.
