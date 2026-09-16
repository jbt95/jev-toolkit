import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  JevApiError,
  JevClient,
  JevClientLive,
  makeFetchTransport,
  makeJevClient,
  type AskInput,
} from "../core/client.ts";
import { EventLogLive, makeEventLog } from "../core/events.ts";
import { makeTestTransport, tempEventsPath } from "../tests/helpers.ts";

const cannedSuccess = JSON.stringify({
  model: "jev-1.13.0",
  answers: { is_dupe: { _tag: "noul", noul: 0.99 } },
  usage: { input_tokens: 100, output_tokens: 10 },
});

const sampleInput: AskInput = {
  harness: "cli",
  state: "My card was charged twice.",
  questions: {
    is_dupe: { _tag: "noul", instructions: "Does this mention a duplicate charge?" },
  },
};

describe("JevClient", () => {
  it("decodes a successful response and logs an ok call event", async () => {
    const log = makeEventLog(await tempEventsPath());
    const client = makeJevClient({
      apiKey: Option.some("test-key"),
      transport: makeTestTransport(() => Effect.succeed(cannedSuccess)),
      log,
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
    expect(first.tokens).toEqual({ input: 100, output: 10 });
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

  it("makeFetchTransport reads a real HTTP response from a local server", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end(cannedSuccess);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    // SAFETY: a TCP server listening on 127.0.0.1 always reports an AddressInfo.
    const { port } = address as AddressInfo;
    try {
      const log = makeEventLog(await tempEventsPath());
      const client = makeJevClient({
        apiKey: Option.some("test-key"),
        transport: makeFetchTransport(`http://127.0.0.1:${port}/v1/systemone`, "test-key"),
        log,
      });
      const result = await Effect.runPromise(client.ask(sampleInput));
      expect(result.model).toBe("jev-1.13.0");
      expect(result.answers["is_dupe"]?._tag).toBe("noul");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("composes through Live layers", async () => {
    const path = await tempEventsPath();
    const live = JevClientLive({
      apiKey: Option.some("test-key"),
      transport: makeTestTransport(() => Effect.succeed(cannedSuccess)),
    }).pipe(Layer.provide(EventLogLive(path)));

    const program = Effect.gen(function* () {
      const client = yield* JevClient;
      return yield* client.ask(sampleInput);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(live)));
    expect(result.model).toBe("jev-1.13.0");
  });
});
