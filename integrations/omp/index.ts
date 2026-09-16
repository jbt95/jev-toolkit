// OMP vendors the Pi extension API; one registration serves both harnesses.
// The Pi extension is a self-contained `jev` CLI shim, so this re-export needs
// the sibling `../pi/` directory present (install from this repo, not a copy
// of this folder alone).
export { default } from "../pi/index.ts";
