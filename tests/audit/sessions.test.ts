import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digestClaude, digestOpencode, digestPiOmp } from "@/audit/sessions.ts";

const fixturesDir = join(import.meta.dirname, "..", "fixtures");
const since = "2026-09-16T00:00:00.000Z";

describe("session digests", () => {
  it("digests Claude sessions with prompts, turns, tools, and errors", async () => {
    const digests = await Effect.runPromise(digestClaude(join(fixturesDir, "claude"), since));

    expect(digests).toHaveLength(1);
    const digest = digests[0];
    expect(digest?.harness).toBe("claude-code");
    expect(digest?.sessionID).toBe("claude-session");
    expect(digest?.userPrompts[0]).toBe("analyze the risks");
    expect(digest?.assistantTurns).toBe(1);
    expect(digest?.toolCounts["Bash"]).toBe(1);
  });

  it("digests Pi sessions using the session header id", async () => {
    const digests = await Effect.runPromise(
      digestPiOmp([{ harness: "pi", root: join(fixturesDir, "pi") }], since),
    );

    expect(digests).toHaveLength(1);
    const digest = digests[0];
    expect(digest?.harness).toBe("pi");
    expect(digest?.sessionID).toBe("pi-session-1");
    expect(digest?.userPrompts).toEqual(["which option is better?"]);
    expect(digest?.assistantTurns).toBe(1);
  });

  it("digests OpenCode sessions from the database", async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), "jev-sessions-")), "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE session_v2 (id TEXT, time_created INTEGER, cost REAL)");
    db.exec(
      "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
    );
    db.prepare("INSERT INTO session_v2 (id, time_created, cost) VALUES (?, ?, ?)").run(
      "ses-1",
      Date.parse("2026-09-16T12:00:00Z"),
      0.25,
    );
    const insertMessage = db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, ?, ?, ?, ?)",
    );
    insertMessage.run("m1", "ses-1", "user", 1, JSON.stringify({ text: "fix the failing test" }));
    insertMessage.run(
      "m2",
      "ses-1",
      "assistant",
      2,
      JSON.stringify({
        content: [
          { type: "text", text: "Working on it." },
          { type: "thinking", name: "not-a-tool" },
          { type: "tool", name: "shell", state: { status: "error" } },
        ],
      }),
    );
    db.close();

    const digests = await Effect.runPromise(digestOpencode(dbPath, since));

    expect(digests).toHaveLength(1);
    const digest = digests[0];
    expect(digest?.harness).toBe("opencode");
    expect(digest?.sessionID).toBe("ses-1");
    expect(digest?.userPrompts).toEqual(["fix the failing test"]);
    expect(digest?.assistantTurns).toBe(1);
    expect(digest?.toolCounts["shell"]).toBe(1);
    expect(Object.keys(digest?.toolCounts ?? {})).toEqual(["shell"]);
    expect(digest?.errorCount).toBe(1);
    expect(digest?.costUsd).toBe(0.25);
  });

  it("digests Claude user entries whose content is an array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-claude-"));
    await writeFile(
      join(dir, "claude-array.jsonl"),
      [
        JSON.stringify({ type: "session", timestamp: "2026-09-16T10:00:00.000Z" }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-09-16T10:01:00.000Z",
          message: {
            content: [
              { type: "tool_result", is_error: true, text: "boom" },
              { type: "text", text: "analyze the risks" },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-09-16T10:02:00.000Z",
          message: { content: [{ type: "text", text: "done" }] },
        }),
      ].join("\n"),
    );

    const digests = await Effect.runPromise(digestClaude(dir, "2026-09-16T00:00:00.000Z"));

    expect(digests).toHaveLength(1);
    expect(digests[0]?.userPrompts.join(" ")).toContain("analyze the risks");
    expect(digests[0]?.errorCount).toBe(1);
  });

  it("propagates non-ENOENT pi root failures and accepts a missing root", async () => {
    const missing = await Effect.runPromise(
      digestPiOmp([{ harness: "pi", root: join(fixturesDir, "absent") }], since),
    );
    expect(missing).toEqual([]);

    const dir = await mkdtemp(join(tmpdir(), "jev-sessions-"));
    const file = join(dir, "not-a-dir");
    await writeFile(file, "x");

    const outcome = await Effect.runPromise(
      Effect.result(digestPiOmp([{ harness: "pi", root: file }], since)),
    );
    expect(outcome._tag).toBe("Failure");
  });
});
