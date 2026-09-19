// OMP vendors the Pi extension API, so one registration serves both harnesses;
// only the manifests differ. Install this package as a directory (plugin
// install), never as a symlink: loaders resolve the relative re-export
// lexically against the link location.
export { default } from "../pi/index.ts";
