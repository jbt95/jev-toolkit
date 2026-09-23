import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  JevApiError,
  JevClient,
  JevClientLive,
  createFetchTransport,
  makeJevClient,
  type AskInput,
} from "@/core/client.ts";
import { EventLogLive, makeEventLog } from "@/core/events.ts";
import { makeTestTransport, startFakeApi, tempEventsPath } from "../helpers.ts";

const cannedSuccess = JSON.stringify({
  model: "jev-1.13.0",
  answers: { is_dupe: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 100, output_tokens: 10 },
});

const sampleInput: AskInput = {
  harness: "cli",
  state: "My card was charged twice.",
  questions: {
    is_dupe: { _tag: "noul", instructions: "Does this mention a duplicate charge?" },
  },
};

/** Run one ask against a canned response body with a fresh temp event log. */
const askWithResponse = async (response: string, input: AskInput = sampleInput) => {
  const log = makeEventLog(await tempEventsPath());
  const client = makeJevClient({
    apiKey: Option.some("test-key"),
    transport: makeTestTransport(() => Effect.succeed(response)),
    log,
  });
  return Effect.runPromise(Effect.result(client.ask(input)));
};

describe("JevClient", () => {
  it("decodes a successful response and logs an ok call event", async () => {
    const log = makeEventLog(await tempEventsPath());
    let sentBody = "";
    const client = makeJevClient({
      apiKey: Option.some("test-key"),
      transport: makeTestTransport((body) => {
        sentBody = body;
        return Effect.succeed(cannedSuccess);
      }),
      log,
    });

    const result = await Effect.runPromise(client.ask(sampleInput));

    expect(sentBody).toContain('"type":"noul"');
    expect(sentBody).not.toContain('"_tag"');
    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers["is_dupe"]?._tag).toBe("noul");
    expect(result.usage).toEqual({ input: 100, output: 10 });

    const events = await Effect.runPromise(log.read());
    expect(events).toHaveLength(1);
    const first = events[0];
    if (first?._tag !== "call") throw new Error("expected a call event");
    expect(first.status).toBe("ok");
    expect(first.callID).toEqual(expect.any(String));
    expect(first.callID?.length).toBeGreaterThan(0);
    expect(first.purpose).toBe("ask");
    expect(first.stateSizeBucket).toBe("0_1k");
    expect(first.tokens).toEqual({ input: 100, output: 10 });
  });

  it("preserves a supplied call identity and semantic purpose", async () => {
    const path = await tempEventsPath();
    const client = makeJevClient({
      apiKey: Option.some("test-key"),
      transport: makeTestTransport(() => Effect.succeed(cannedSuccess)),
      log: makeEventLog(path),
    });

    await Effect.runPromise(
      client.ask({ ...sampleInput, callID: "call-local-1", purpose: "verify" }),
    );

    const event = (await Effect.runPromise(makeEventLog(path).read())).find(
      (entry) => entry._tag === "call",
    );
    expect(event).toMatchObject({ callID: "call-local-1", purpose: "verify" });
  });

  it("logs an error event and fails with JevApiError on HTTP failure", async () => {
    const log = makeEventLog(await tempEventsPath());
    const client = makeJevClient({
      apiKey: Option.some("test-key"),
      transport: makeTestTransport(() => Effect.fail(new JevApiError({ status: 500 }))),
      log,
    });

    const outcome = await Effect.runPromise(Effect.result(client.ask(sampleInput)));

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("JevApiError");

    const events = await Effect.runPromise(log.read());
    expect(events).toHaveLength(1);
    const first = events[0];
    if (first?._tag !== "call") throw new Error("expected a call event");
    expect(first.status).toBe("error");
  });

  it("fails with JevConfigError when the API key is missing", async () => {
    const log = makeEventLog(await tempEventsPath());
    const client = makeJevClient({
      apiKey: Option.none(),
      transport: makeTestTransport(() => Effect.succeed(cannedSuccess)),
      log,
    });

    const outcome = await Effect.runPromise(Effect.result(client.ask(sampleInput)));

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("JevConfigError");
    expect(await Effect.runPromise(log.read())).toHaveLength(1);
  });

  it("fails with JevDecodeError on an unexpected response shape", async () => {
    const log = makeEventLog(await tempEventsPath());
    const client = makeJevClient({
      apiKey: Option.some("test-key"),
      transport: makeTestTransport(() => Effect.succeed("not json")),
      log,
    });

    const outcome = await Effect.runPromise(Effect.result(client.ask(sampleInput)));

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("JevDecodeError");
  });

  it("rejects a response that omits a requested answer", async () => {
    const outcome = await askWithResponse(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {},
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("JevDecodeError");
  });

  it("rejects wrong primitives, out-of-range values, and extra answers", async () => {
    const badAnswers: ReadonlyArray<object> = [
      { is_dupe: { type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 0.9 } } },
      { is_dupe: { type: "noul", noul: 1.4 } },
      { is_dupe: { type: "noul", noul: 0.9 }, extra: { type: "noul", noul: 0.5 } },
    ];
    for (const answers of badAnswers) {
      const outcome = await askWithResponse(
        JSON.stringify({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("JevDecodeError");
    }
  });

  it("rejects choices and scores outside their criteria", async () => {
    const choiceInput: AskInput = {
      harness: "cli",
      state: "text",
      questions: {
        risk: { _tag: "choice", instructions: "Risk?", criteria: { low: "safe", high: "risky" } },
      },
    };
    const scoreInput: AskInput = {
      harness: "cli",
      state: "text",
      questions: {
        severity: { _tag: "score", instructions: "Severity?", criteria: ["Minor", "Major"] },
      },
    };
    const badCases: ReadonlyArray<readonly [AskInput, object]> = [
      [
        choiceInput,
        {
          risk: {
            type: "choice",
            choice: "extreme",
            confidence: 0.9,
            probabilities: { extreme: 0.9 },
          },
        },
      ],
      [
        choiceInput,
        { risk: { type: "choice", choice: "low", confidence: 1.2, probabilities: { low: 1.2 } } },
      ],
      [scoreInput, { severity: { type: "score", score: 5, confidence: 0.7 } }],
    ];
    for (const [input, answers] of badCases) {
      const outcome = await askWithResponse(
        JSON.stringify({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        input,
      );
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("JevDecodeError");
    }
  });

  it("accepts in-range choices and scores", async () => {
    const input: AskInput = {
      harness: "cli",
      state: "text",
      questions: {
        risk: { _tag: "choice", instructions: "Risk?", criteria: { low: "safe", high: "risky" } },
        severity: { _tag: "score", instructions: "Severity?", criteria: ["Minor", "Major"] },
      },
    };
    const outcome = await askWithResponse(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          risk: { type: "choice", choice: "low", confidence: 0.8, probabilities: { low: 0.8 } },
          severity: { type: "score", score: 1, confidence: 0.6 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      input,
    );

    expect(outcome._tag).toBe("Success");
  });

  it("makeFetchTransport reads a real HTTP response from a local server", async () => {
    const api = await startFakeApi(() => cannedSuccess);
    try {
      const log = makeEventLog(await tempEventsPath());
      const client = makeJevClient({
        apiKey: Option.some("test-key"),
        transport: createFetchTransport(api.url, "test-key"),
        log,
      });
      const result = await Effect.runPromise(client.ask(sampleInput));
      expect(result.model).toBe("jev-1.13.0");
      expect(result.answers["is_dupe"]?._tag).toBe("noul");
    } finally {
      await api.close();
    }
  });

  it("composes through Live layers", async () => {
    const path = await tempEventsPath();
    const live = JevClientLive({
      apiKey: Option.some("test-key"),
      transport: makeTestTransport(() => Effect.succeed(cannedSuccess)),
    }).pipe(Layer.provide(EventLogLive(path)));

    const program = Effect.gen(function* clientAskProgram() {
      const client = yield* JevClient;
      return yield* client.ask(sampleInput);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(live)));
    expect(result.model).toBe("jev-1.13.0");
  });
});
