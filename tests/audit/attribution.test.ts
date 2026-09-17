import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attributeCalls, loadOpencodeTurns, type SessionTurn } from "@/audit/attribution.ts";

const turn = (sessionID: string, startMs: number, endMs: number, askText: string): SessionTurn => ({
  sessionID,
  startMs,
  endMs,
  askText,
});

const resolved = (option: Option.Option<string> | undefined): string | undefined =>
  option === undefined || Option.isNone(option) ? undefined : option.value;

describe("attributeCalls", () => {
  it("matches a call to the assistant turn that issued its question ids", () => {
    const calls = [{ questionIDs: ["recommendation", "causal_claim"], atMs: 1000 }];
    const turns = [
      turn("other", 900, 1100, "unrelated prose"),
      turn(
        "target",
        800,
        1200,
        "tools.jev.typesafe_ask({ questions: { recommendation: {}, causal_claim: {} } })",
      ),
    ];

    const [result] = attributeCalls(turns, calls);

    expect(resolved(result)).toBe("target");
  });

  it("returns none without question ids or without a matching turn", () => {
    expect(
      attributeCalls([turn("s", 0, 10, "typesafe_ask")], [{ questionIDs: [], atMs: 5 }])[0],
    ).toEqual(Option.none());
    expect(
      attributeCalls(
        [turn("s", 0, 10, "typesafe_ask other")],
        [{ questionIDs: ["q"], atMs: 5 }],
      )[0],
    ).toEqual(Option.none());
  });

  it("requires every question id and stays inside the attribution window", () => {
    const partial = [turn("s", 0, 1000, "typesafe_ask only q1 here")];
    expect(attributeCalls(partial, [{ questionIDs: ["q1", "q2"], atMs: 500 }])[0]).toEqual(
      Option.none(),
    );

    const distant = [turn("s", 0, 1, "typesafe_ask q1")];
    expect(attributeCalls(distant, [{ questionIDs: ["q1"], atMs: 60 * 60 * 1000 }])[0]).toEqual(
      Option.none(),
    );
  });

  it("breaks ties by the tightest turn", () => {
    const turns = [
      turn("wide", 0, 1000, "typesafe_ask q1"),
      turn("tight", 400, 600, "typesafe_ask q1"),
    ];
    const [result] = attributeCalls(turns, [{ questionIDs: ["q1"], atMs: 500 }]);
    expect(resolved(result)).toBe("tight");
  });
});

describe("loadOpencodeTurns", () => {
  it("keeps only assistant turns that issued an ask, with their windows", async () => {
    const missing = await Effect.runPromise(
      loadOpencodeTurns(join(tmpdir(), "jev-absent-attribution.db"), "2026-01-01T00:00:00.000Z"),
    );
    expect(missing).toEqual([]);

    const dbPath = join(await mkdtemp(join(tmpdir(), "jev-attribution-")), "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE session_message (session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)");
    insert.run(
      "sess-1",
      "assistant",
      100,
      200,
      JSON.stringify({
        content: [
          {
            type: "tool",
            name: "execute",
            state: { input: { code: "return tools.jev.typesafe_ask({ questions: { q1: {} } })" } },
          },
        ],
      }),
    );
    insert.run(
      "sess-2",
      "assistant",
      100,
      200,
      JSON.stringify({ content: [{ type: "text", text: "no ask here" }] }),
    );
    insert.run("sess-3", "user", 100, 200, JSON.stringify({ text: "x" }));
    db.close();

    const turns = await Effect.runPromise(loadOpencodeTurns(dbPath, "1970-01-01T00:00:00.000Z"));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sessionID).toBe("sess-1");
    expect(turns[0]?.startMs).toBe(100);
    expect(turns[0]?.endMs).toBe(200);
    expect(turns[0]?.askText).toContain("q1");
  });
});
