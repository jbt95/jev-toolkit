import * as Predicate from "effect/Predicate";

/**
 * True when a filesystem failure means the path is absent. Only ENOENT is a
 * benign "nothing here yet" signal; permission, I/O, and decode failures must
 * surface instead of reading as empty data.
 */
export const isNotFoundError = <A>(cause: A): boolean =>
  Predicate.isObject(cause) && "code" in cause && cause.code === "ENOENT";
