import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  extractClaude,
  extractOpencode,
  extractPiOmp,
  toDetectedOpportunity,
  type RawMessage,
} from "@/audit/opportunities.ts";

const fixturesDir = join(import.meta.dirname, "..", "fixtures");
const since = "2026-09-16T00:00:00.000Z";

const makeDb = async (): Promise<string> => {
  const dbPath = join(await mkdtemp(join(tmpdir(), "jev-audit-")), "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)",
  );
  db.close();
  return dbPath;
};

const insertRow = (
  dbPath: string,
  id: string,
  type: string,
  timeCreated: number,
  text: string,
): void => {
  const db = new DatabaseSync(dbPath);
  const payload = type === "user" ? { text } : { content: [{ type: "text", text }] };
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "sess-1", type, timeCreated, JSON.stringify(payload));
  db.close();
};

describe("audit extractors", () => {
  it("extracts assistant messages from Claude session logs", async () => {
    const messages = await Effect.runPromise(extractClaude(join(fixturesDir, "claude"), since));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain("roughly 30%");
    expect(messages[0]?.harness).toBe("claude-code");
    expect(messages[0]?.sessionID).toBe("claude-session");
  });

  it("extracts assistant messages from Pi/OMP session logs", async () => {
    const messages = await Effect.runPromise(
      extractPiOmp([{ harness: "pi", root: join(fixturesDir, "pi") }], since),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain("60%");
    expect(messages[0]?.sessionID).toBe("pi-session-1");
  });

  it("filters the OpenCode database by message type and time", async () => {
    const dbPath = await makeDb();
    insertRow(dbPath, "m1", "assistant", Date.parse("2026-09-16T12:00:00Z"), "About 70% done.");
    insertRow(dbPath, "m2", "assistant", Date.parse("2026-08-01T00:00:00Z"), "Old news.");
    insertRow(dbPath, "m3", "user", Date.parse("2026-09-16T12:01:00Z"), "which option is better?");

    const assistant = await Effect.runPromise(extractOpencode(dbPath, since, "assistant"));
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toContain("70%");

    const prompts = await Effect.runPromise(extractOpencode(dbPath, since, "user"));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain("which option is better?");
  });

  it("strips fenced code before messages leave the machine", async () => {
    const dbPath = await makeDb();
    insertRow(
      dbPath,
      "m1",
      "assistant",
      Date.parse("2026-09-16T12:00:00Z"),
      "The fix is small:\n```ts\nconst secret = 'raw code';\n```\nCoverage is 91%.",
    );

    const assistant = await Effect.runPromise(extractOpencode(dbPath, since, "assistant"));
    expect(assistant[0]?.text).toContain("[code]");
    expect(assistant[0]?.text).not.toContain("const secret");
    expect(assistant[0]?.text).toContain("91%");
  });

  it("quotes the prefilter span and carries a context window for alignment", () => {
    const message: RawMessage = { harness: "cli", sessionID: "s", text: "About 70% done." };
    const percent = toDetectedOpportunity(message, "percent");
    expect(percent.excerpt).toBe("70%");
    expect(percent.context).toBe("About 70% done.");

    const fallback = toDetectedOpportunity({ ...message, text: "prefer A over B" }, "choice");
    expect(fallback.excerpt).toBe("prefer A over B");
    expect(fallback.context).toBe("prefer A over B");

    const padded = `${"x".repeat(200)} 70% ${"y".repeat(200)}`;
    const windowed = toDetectedOpportunity({ ...message, text: padded }, "percent");
    expect(windowed.context).toContain("70%");
    expect(windowed.context.length).toBeLessThan(padded.length);
  });

  it("propagates non-ENOENT pi root failures and accepts a missing root", async () => {
    const missing = await Effect.runPromise(
      extractPiOmp([{ harness: "omp", root: join(fixturesDir, "absent") }], since),
    );
    expect(missing).toEqual([]);

    const dir = await mkdtemp(join(tmpdir(), "jev-audit-"));
    const file = join(dir, "not-a-dir");
    await writeFile(file, "x");

    const outcome = await Effect.runPromise(
      Effect.result(extractPiOmp([{ harness: "omp", root: file }], since)),
    );
    expect(outcome._tag).toBe("Failure");
  });
});
