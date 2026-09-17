import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, makeLoopGuard } from "@/core/loops.ts";

const tempStatePath = async () =>
  join(await mkdtemp(join(tmpdir(), "jev-loop-")), "loop-state.json");

describe("loop guard", () => {
  it("escalates once on the third identical failure", async () => {
    const guard = makeLoopGuard(await tempStatePath());

    const first = await Effect.runPromise(guard.check("fp-a"));
    const second = await Effect.runPromise(guard.check("fp-a"));
    const third = await Effect.runPromise(guard.check("fp-a"));
    const fourth = await Effect.runPromise(guard.check("fp-a"));

    expect(first).toEqual({ count: 1, escalated: false });
    expect(second).toEqual({ count: 2, escalated: false });
    expect(third).toEqual({ count: 3, escalated: true });
    expect(fourth).toEqual({ count: 4, escalated: false });
  });

  it("prunes stale entries and tolerates a missing state file", async () => {
    const path = await tempStatePath();
    const stale = { count: 9, lastTs: Date.now() - 48 * 60 * 60 * 1000, escalated: true };
    await writeFile(path, JSON.stringify({ "old-fp": stale }));

    const guard = makeLoopGuard(path);
    const check = await Effect.runPromise(guard.check("new-fp"));
    expect(check).toEqual({ count: 1, escalated: false });

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("old-fp");
    expect(raw).toContain("new-fp");

    const missing = makeLoopGuard(await tempStatePath());
    await expect(Effect.runPromise(missing.check("fp"))).resolves.toEqual({
      count: 1,
      escalated: false,
    });
  });

  it("fails loudly on a malformed state file", async () => {
    const path = await tempStatePath();
    await writeFile(path, "not json");
    const malformed = makeLoopGuard(path);

    const outcome = await Effect.runPromise(Effect.result(malformed.check("fp")));

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("LoopError");
  });

  it("fails on non-ENOENT read failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-loop-"));
    const guard = makeLoopGuard(dir); // a directory cannot be read as a state file

    const outcome = await Effect.runPromise(Effect.result(guard.recent(1)));

    expect(outcome._tag).toBe("Failure");
  });

  it("fingerprints ignore case and whitespace", () => {
    expect(fingerprint("Error:  Boom\n")).toBe(fingerprint("error: boom"));
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
  });

  it("stores samples and reports recent failures newest first", async () => {
    const guard = makeLoopGuard(await tempStatePath());
    await Effect.runPromise(guard.check("fp-old", "old failure text"));
    await Effect.runPromise(guard.check("fp-new", "new failure text"));
    await Effect.runPromise(guard.check("fp-bare"));

    const recent = await Effect.runPromise(guard.recent(5));

    expect(recent.map((entry) => entry.fingerprint)).toEqual(["fp-new", "fp-old"]);
    expect(recent[0]?.sample).toBe("new failure text");
    expect(recent.map((entry) => entry.fingerprint)).not.toContain("fp-bare");
  });
});
