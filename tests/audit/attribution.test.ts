import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  attributeCalls,
  loadOpencodeTurns,
  loadPiOmpTurns,
  type SessionTurn,
} from "@/audit/attribution.ts";

const turn = (
  sessionID: string,
  startMs: number,
  endMs: number,
  askText: string,
  markers: ReadonlyArray<string> = ["typesafe_ask"],
): SessionTurn => ({
  sessionID,
  startMs,
  endMs,
  askText,
  markers,
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

  it("attributes verify calls to the nearest turn that invoked verify", () => {
    const turns = [
      turn("ask-only", 800, 1200, "tools.jev.typesafe_ask({ questions: { q: {} } })", [
        "typesafe_ask",
      ]),
      turn("verified", 800, 1200, "tools.jev.typesafe_verify({ claims: [] })", ["typesafe_verify"]),
    ];
    const [result] = attributeCalls(turns, [
      { questionIDs: ["c0_verdict", "c1_verdict"], atMs: 1000 },
    ]);
    expect(resolved(result)).toBe("verified");
  });

  it("attributes review calls to the nearest turn that invoked review", () => {
    const turns = [
      turn("ask-only", 800, 1200, "tools.jev.typesafe_ask({ questions: { q: {} } })", [
        "typesafe_ask",
      ]),
      turn("reviewed", 800, 1200, "tools.jev.typesafe_review({ task: 'x' })", ["typesafe_review"]),
    ];
    const [result] = attributeCalls(turns, [
      { questionIDs: ["correctness_applicable", "correctness_score"], atMs: 1000 },
    ]);
    expect(resolved(result)).toBe("reviewed");
  });

  it("leaves verify and review calls unmatched without a same-tool turn", () => {
    const turns = [turn("ask-only", 800, 1200, "typesafe_ask q")];
    expect(attributeCalls(turns, [{ questionIDs: ["c0_verdict"], atMs: 1000 }])[0]).toEqual(
      Option.none(),
    );
    expect(
      attributeCalls(turns, [{ questionIDs: ["correctness_applicable"], atMs: 1000 }])[0],
    ).toEqual(Option.none());
  });

  it("keeps ask-shaped ids on the id-matching path", () => {
    const turns = [turn("s", 800, 1200, "typesafe_verify other prose", ["typesafe_verify"])];
    expect(attributeCalls(turns, [{ questionIDs: ["export_location"], atMs: 1000 }])[0]).toEqual(
      Option.none(),
    );
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
      "sess-verify",
      "assistant",
      100,
      200,
      JSON.stringify({
        content: [
          {
            type: "tool",
            name: "execute",
            state: { input: { code: "return tools.jev.typesafe_verify({ claims: [] })" } },
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
    expect(turns).toHaveLength(2);
    expect(turns[0]?.sessionID).toBe("sess-1");
    expect(turns[0]?.startMs).toBe(100);
    expect(turns[0]?.endMs).toBe(200);
    expect(turns[0]?.askText).toContain("q1");
    expect(turns[0]?.markers).toEqual(["typesafe_ask"]);
    expect(turns[1]?.sessionID).toBe("sess-verify");
    expect(turns[1]?.markers).toEqual(["typesafe_verify"]);
  });
});

const writeJsonl = async (path: string, lines: ReadonlyArray<unknown>): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
};

const ompRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "jev-test-omp-"));

describe("loadPiOmpTurns", () => {
  it("reads device writes to a Jev tool and keeps their question keys", async () => {
    const root = await ompRoot();
    await writeJsonl(join(root, "-proj", "2026-09-19T09-00-00-000Z_session.jsonl"), [
      { type: "session", version: 3, id: "sess-omp", timestamp: "2026-09-19T09:00:00.000Z" },
      {
        type: "message",
        id: "m1",
        timestamp: "2026-09-19T09:00:05.000Z",
        message: { role: "user", content: [{ type: "text", text: "judge this" }] },
      },
      {
        type: "message",
        id: "m2",
        timestamp: "2026-09-19T09:01:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            {
              type: "toolCall",
              id: "call_1",
              name: "write",
              arguments: {
                path: "xd://mcp__jev_typesafe_ask",
                content: JSON.stringify({
                  state: "s",
                  questions: { quality: { _tag: "noul" }, severity: { _tag: "score" } },
                }),
              },
            },
            {
              type: "toolCall",
              id: "call_2",
              name: "write",
              arguments: { path: "src/notes.md", content: "no judgment here" },
            },
          ],
        },
      },
    ]);

    const turns = await Effect.runPromise(
      loadPiOmpTurns([{ harness: "omp", root }], "2026-09-19T00:00:00.000Z"),
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.sessionID).toBe("sess-omp");
    expect(turns[0]?.askText).toContain("quality");
    expect(turns[0]?.askText).toContain("severity");
    expect(turns[0]?.markers).toEqual(["typesafe_ask"]);
    expect(turns[0]?.startMs).toBe(Date.parse("2026-09-19T09:01:00.000Z"));
  });

  it("reads first-class MCP calls and honors the since window", async () => {
    const root = await ompRoot();
    await writeJsonl(join(root, "-proj", "session-b.jsonl"), [
      {
        type: "message",
        id: "old",
        timestamp: "2026-09-18T09:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_old",
              name: "mcp__jev_typesafe_ask",
              arguments: { state: "s", questions: { stale: { _tag: "noul" } } },
            },
          ],
        },
      },
      {
        type: "message",
        id: "new",
        timestamp: "2026-09-19T09:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_verify",
              name: "mcp__jev_typesafe_verify",
              arguments: { claims: [], evidence: "x" },
            },
          ],
        },
      },
    ]);

    const turns = await Effect.runPromise(
      loadPiOmpTurns([{ harness: "omp", root }], "2026-09-19T00:00:00.000Z"),
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.markers).toEqual(["typesafe_verify"]);
  });

  it("yields session ids that attributeCalls can resolve", async () => {
    const root = await ompRoot();
    await writeJsonl(join(root, "-proj", "nested", "session-c.jsonl"), [
      {
        type: "message",
        id: "m1",
        timestamp: "2026-09-19T09:10:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "write",
              arguments: {
                path: "xd://mcp__jev_typesafe_ask",
                content: JSON.stringify({
                  state: "s",
                  questions: { decision: { _tag: "choice" } },
                }),
              },
            },
          ],
        },
      },
    ]);

    const turns = await Effect.runPromise(
      loadPiOmpTurns([{ harness: "omp", root }], "2026-09-19T00:00:00.000Z"),
    );
    const resolved = attributeCalls(turns, [
      { questionIDs: ["decision"], atMs: Date.parse("2026-09-19T09:10:30.000Z") },
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.pipe(Option.getOrUndefined)).toBe("session-c");
  });
});
