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

  it("prunes stale entries and tolerates a missing or malformed state file", async () => {
    const path = await tempStatePath();
    const stale = { count: 9, lastTs: Date.now() - 48 * 60 * 60 * 1000, escalated: true };
    await writeFile(path, JSON.stringify({ "old-fp": stale }));

    const guard = makeLoopGuard(path);
    const check = await Effect.runPromise(guard.check("new-fp"));
    expect(check).toEqual({ count: 1, escalated: false });

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("old-fp");
    expect(raw).toContain("new-fp");

    const malformed = makeLoopGuard(path);
    await writeFile(path, "not json");
    await expect(Effect.runPromise(malformed.check("fp"))).resolves.toEqual({
      count: 1,
      escalated: false,
    });
  });

  it("fingerprints ignore case and whitespace", () => {
    expect(fingerprint("Error:  Boom\n")).toBe(fingerprint("error: boom"));
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
  });
});
