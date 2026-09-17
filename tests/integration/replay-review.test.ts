import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  installFailingJev,
  installFakeJev,
  makeOpencodeDb,
  tempDir,
  withPath,
} from "../helpers.ts";

const load = async (argv: ReadonlyArray<string>): Promise<void> => {
  process.argv = ["node", "review.ts", ...argv];
  vi.resetModules();
  await import("@/replay/review.ts");
};

afterEach(() => {
  delete process.env.JEV_OPENCODE_DB;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe("replay review tool", () => {
  it("captures findings from review-titled sessions", async () => {
    const db = await makeOpencodeDb();
    const day = Date.parse("2026-09-16T12:00:00Z");
    db.insertSession("ses_review_0001", "Parser review", day);
    db.insertMessage(
      "m1",
      "assistant",
      day,
      "- Missing null check in the handler\n## Import order is wrong\nthe rest is fine",
      "ses_review_0001",
    );
    db.insertMessage("m2", "assistant", day, "- Another finding worth fixing", "ses_review_0001");
    process.env.JEV_OPENCODE_DB = db.path;
    const out = await tempDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await load(["--capture", "--date", "2026-09-16", "--out", out]);

    const files = await readdir(out);
    expect(files).toHaveLength(1);
    const fixture = JSON.parse(await readFile(join(out, files[0] ?? ""), "utf8"));
    expect(fixture.findings.length).toBeGreaterThanOrEqual(3);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain("captured 1 reviewer sessions");
  });

  it("scores fixtures by the classes the CLI routes", async () => {
    const dir = await tempDir();
    const fixture = join(dir, "f1.json");
    await writeFile(fixture, JSON.stringify({ meta: {}, findings: [] }));
    const routed = JSON.stringify({
      blockers: [{ id: "a" }],
      cosmetic: [],
      questions: [],
      reviewSubstantive: true,
      truncated: false,
    });
    const { binDir } = await installFakeJev({ [`triage review --input ${fixture}`]: routed });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await withPath(binDir, async () => {
      await load(["--score", "--dir", dir]);
    });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("blockers=1");
    expect(output).toContain("totals: fixtures=1 blockers=1 cosmetic=0 questions=0");
  });

  it("reports unparseable CLI output and CLI failures", async () => {
    const dir = await tempDir();
    const fixture = join(dir, "f1.json");
    await writeFile(fixture, JSON.stringify({ meta: {}, findings: [] }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const unparseable = await installFakeJev({ [`triage review --input ${fixture}`]: "not json" });
    await withPath(unparseable.binDir, async () => {
      await load(["--score", "--dir", dir]);
    });
    const failing = await installFailingJev();
    await withPath(failing.binDir, async () => {
      await load(["--score", "--dir", dir]);
    });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("unparseable output");
    expect(output).toContain("ERROR");
  });

  it("prints usage and exits 1 without --capture or --score", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await load([]);

    expect(process.exitCode).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("usage: src/replay/review.ts");
  });
});
