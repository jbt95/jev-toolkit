import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digestClaude, digestOpencode, digestPiOmp } from "./sessions.ts";

const fixturesDir = join(import.meta.dirname, "..", "..", "tests", "fixtures");
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
          { type: "tool", name: "shell", state: { status: "error" } },
        ],
      }),
    );
    db.close();

    const digests = await Effect.runPromise(digestOpencode(dbPath, since));

    expect(digests).toHaveLength(1);
    const digest = digests[0];
    expect(digest?.harness).toBe("opencode2");
    expect(digest?.sessionID).toBe("ses-1");
    expect(digest?.userPrompts).toEqual(["fix the failing test"]);
    expect(digest?.assistantTurns).toBe(1);
    expect(digest?.toolCounts["shell"]).toBe(1);
    expect(digest?.costUsd).toBe(0.25);
  });
});
