import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  correlate,
  extractClaude,
  extractOpencode,
  extractPiOmp,
  type RawOpportunity,
} from "./opportunities.ts";

const fixturesDir = join(import.meta.dirname, "..", "tests", "fixtures");
const since = "2026-09-16T00:00:00.000Z";

describe("audit extractors", () => {
  it("extracts assistant claims from Claude session logs", async () => {
    const opportunities = await Effect.runPromise(
      extractClaude(join(fixturesDir, "claude"), since),
    );
    expect(opportunities.map((entry) => entry.pattern)).toEqual(["percent", "estimate"]);
    expect(opportunities[0]?.harness).toBe("claude-code");
    expect(opportunities[0]?.sessionID).toBe("claude-session");
  });

  it("extracts assistant claims from Pi/OMP session logs", async () => {
    const opportunities = await Effect.runPromise(
      extractPiOmp([{ harness: "pi", root: join(fixturesDir, "pi") }], since),
    );
    expect(opportunities.map((entry) => entry.pattern)).toEqual([
      "percent",
      "probability",
      "estimate",
    ]);
    expect(opportunities[0]?.sessionID).toBe("pi-session-1");
  });

  it("extracts assistant claims from the OpenCode session database", async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), "jev-audit-")), "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(
      "m1",
      "sess-1",
      "assistant",
      Date.parse("2026-09-16T12:00:00Z"),
      JSON.stringify({ content: [{ type: "text", text: "About 70% of the batch." }] }),
    );
    insert.run(
      "m2",
      "sess-1",
      "assistant",
      Date.parse("2026-08-01T00:00:00Z"),
      JSON.stringify({ content: [{ type: "text", text: "This is likely old news." }] }),
    );
    db.close();

    const opportunities = await Effect.runPromise(extractOpencode(dbPath, since));
    expect(opportunities.map((entry) => entry.pattern)).toEqual(["percent", "estimate"]);
    expect(opportunities[0]?.harness).toBe("opencode2");
    expect(opportunities[0]?.sessionID).toBe("sess-1");
  });

  it("returns nothing for a missing OpenCode database", async () => {
    const opportunities = await Effect.runPromise(
      extractOpencode("/nonexistent/opencode.db", since),
    );
    expect(opportunities).toHaveLength(0);
  });

  it("correlates opportunities with call events by harness and session", () => {
    const opportunities: ReadonlyArray<RawOpportunity> = [
      {
        harness: "cli",
        sessionID: "s1",
        source: "assistant_message",
        pattern: "percent",
        matchedText: "10%",
      },
      {
        harness: "cli",
        sessionID: "s2",
        source: "assistant_message",
        pattern: "ranking",
        matchedText: "best",
      },
    ];
    const correlated = correlate(opportunities, [
      {
        _tag: "call",
        ts: "2026-09-16T00:00:00.000Z",
        harness: "cli",
        sessionID: "s1",
        model: "jev-latest",
        latencyMs: 10,
        status: "ok",
        questions: [],
      },
    ]);
    expect(correlated.map((entry) => entry.matched)).toEqual([true, false]);
  });
});
