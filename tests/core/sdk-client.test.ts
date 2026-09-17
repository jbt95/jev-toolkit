import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Fetch } from "@typesafe-ai/sdk";
import type { AskInput } from "@/core/client.ts";
import { makeEventLog } from "@/core/events.ts";
import { makeSdkJevClient, sdkBaseURL } from "@/core/sdk-client.ts";
import { tempEventsPath } from "../helpers.ts";

const wireSuccess = JSON.stringify({
  model: "jev-1.13.0",
  answers: { is_dupe: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 100, output_tokens: 10 },
});

const okFetch =
  (body: string): Fetch =>
  (_input, _init) =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

const statusFetch =
  (status: number): Fetch =>
  (_input, _init) =>
    Promise.resolve(new Response("boom", { status }));

const sampleInput: AskInput = {
  harness: "cli",
  state: "My card was charged twice.",
  questions: {
    is_dupe: { _tag: "noul", instructions: "Does this mention a duplicate charge?" },
  },
};

describe("makeSdkJevClient", () => {
  it("decodes a successful response and logs an ok call event", async () => {
    const path = await tempEventsPath();
    const log = makeEventLog(path);
    const client = makeSdkJevClient({
      apiKey: Option.some("test-key"),
      log,
      fetch: okFetch(wireSuccess),
    });

    const result = await Effect.runPromise(client.ask(sampleInput));

    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers["is_dupe"]?._tag).toBe("noul");
    expect(result.usage).toEqual({ input: 100, output: 10 });

    const events = await Effect.runPromise(log.read());
    expect(events).toHaveLength(1);
    const first = events[0];
    if (first?._tag !== "call") throw new Error("expected a call event");
    expect(first.status).toBe("ok");
  });

  it("accepts in-range choices and scores with SDK legends", async () => {
    const path = await tempEventsPath();
    const client = makeSdkJevClient({
      apiKey: Option.some("test-key"),
      log: makeEventLog(path),
      fetch: okFetch(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            risk: {
              type: "choice",
              choice: "low",
              confidence: 0.8,
              probabilities: { low: 0.8 },
            },
            severity: {
              type: "score",
              score: 1,
              confidence: 0.6,
              legend: { 0: "Minor", 1: "Major" },
              probabilities: { 0: 0.4, 1: 0.6 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    });

    const outcome = await Effect.runPromise(
      Effect.result(
        client.ask({
          harness: "cli",
          state: "text",
          questions: {
            risk: {
              _tag: "choice",
              instructions: "Risk?",
              criteria: { low: "safe", high: "risky" },
            },
            severity: { _tag: "score", instructions: "Severity?", criteria: ["Minor", "Major"] },
          },
        }),
      ),
    );

    expect(outcome._tag).toBe("Success");
  });

  it("fails with JevApiError on HTTP failure", async () => {
    const path = await tempEventsPath();
    const log = makeEventLog(path);
    const client = makeSdkJevClient({
      apiKey: Option.some("test-key"),
      log,
      fetch: statusFetch(500),
    });

    const outcome = await Effect.runPromise(Effect.result(client.ask(sampleInput)));

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("JevApiError");
    const events = await Effect.runPromise(log.read());
    expect(events).toHaveLength(1);
  });

  it("fails with JevConfigError when the API key is missing", async () => {
    const path = await tempEventsPath();
    const log = makeEventLog(path);
    const client = makeSdkJevClient({ apiKey: Option.none(), log, fetch: okFetch(wireSuccess) });

    const outcome = await Effect.runPromise(Effect.result(client.ask(sampleInput)));

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("JevConfigError");
    expect(await Effect.runPromise(log.read())).toHaveLength(1);
  });

  it("fails with JevDecodeError on empty questions and short score rubrics", async () => {
    const path = await tempEventsPath();
    const log = makeEventLog(path);
    const client = makeSdkJevClient({
      apiKey: Option.some("test-key"),
      log,
      fetch: okFetch(wireSuccess),
    });

    const empty = await Effect.runPromise(
      Effect.result(client.ask({ harness: "cli", state: "text", questions: {} })),
    );
    expect(empty._tag).toBe("Failure");
    if (empty._tag === "Failure") expect(empty.failure._tag).toBe("JevDecodeError");

    const shortRubric = await Effect.runPromise(
      Effect.result(
        client.ask({
          harness: "cli",
          state: "text",
          questions: { severity: { _tag: "score", instructions: "Severity?", criteria: ["Only"] } },
        }),
      ),
    );
    expect(shortRubric._tag).toBe("Failure");
    if (shortRubric._tag === "Failure") expect(shortRubric.failure._tag).toBe("JevDecodeError");
  });

  it("rejects a response that answers with the wrong primitive", async () => {
    const path = await tempEventsPath();
    const client = makeSdkJevClient({
      apiKey: Option.some("test-key"),
      log: makeEventLog(path),
      fetch: okFetch(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            is_dupe: {
              type: "choice",
              choice: "yes",
              confidence: 0.9,
              probabilities: { yes: 0.9 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    });

    const outcome = await Effect.runPromise(Effect.result(client.ask(sampleInput)));

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("JevDecodeError");
  });

  it("sends the type-tagged wire shape without internal tags", async () => {
    const bodies: Array<string> = [];
    const loggingFetch: Fetch = (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return Promise.resolve(
        new Response(wireSuccess, { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    };
    const path = await tempEventsPath();
    const client = makeSdkJevClient({
      apiKey: Option.some("test-key"),
      log: makeEventLog(path),
      fetch: loggingFetch,
    });
    await Effect.runPromise(client.ask(sampleInput));

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('"type":"noul"');
    expect(bodies[0]).not.toContain("_tag");
  });
});

describe("sdkBaseURL", () => {
  it("strips the systemone path and leaves custom endpoints alone", () => {
    expect(sdkBaseURL("https://api.typesafe.ai/v1/systemone")).toBe("https://api.typesafe.ai");
    expect(sdkBaseURL("https://proxy.internal/jev")).toBe("https://proxy.internal/jev");
  });
});
