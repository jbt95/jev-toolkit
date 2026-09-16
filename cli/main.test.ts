import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { runCli } from "../cli/jev.ts";
import { JevClient, makeJevClient } from "../core/client.ts";
import { EventLog, EventLogLive, makeEventLog } from "../core/events.ts";
import { makeTestTransport, tempEventsPath } from "../tests/helpers.ts";

const cannedSuccess = JSON.stringify({
  model: "jev-1.13.0",
  answers: { is_dupe: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 100, output_tokens: 10 },
});

const layersFor = (path: string, response = cannedSuccess): Layer.Layer<JevClient | EventLog> =>
  Layer.mergeAll(
    EventLogLive(path),
    Layer.succeed(
      JevClient,
      makeJevClient({
        apiKey: Option.some("test-key"),
        transport: makeTestTransport(() => Effect.succeed(response)),
        log: makeEventLog(path),
      }),
    ),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jev CLI", () => {
  it("prints recent events as JSON lines", async () => {
    const path = await tempEventsPath();
    await Effect.runPromise(
      makeEventLog(path).append({
        _tag: "opportunity",
        ts: "2026-09-17T00:00:00.000Z",
        harness: "cli",
        source: "assistant_message",
        pattern: "percent",
        matched: false,
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const code = await Effect.runPromise(runCli(["events"], layersFor(path)));

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('"opportunity"');
  });

  it("prints formatted answers for a valid ask payload", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const input = JSON.stringify({
      state: "My card was charged twice.",
      questions: { is_dupe: { _tag: "noul", instructions: "Duplicate charge?" } },
    });

    const code = await Effect.runPromise(
      runCli(["ask"], layersFor(await tempEventsPath()), () => Effect.succeed(input)),
    );

    expect(code).toBe(0);
    const output = String(logSpy.mock.calls[0]?.[0]);
    expect(output).toContain("p(yes)=0.99");
  });

  it("fails with exit code 1 on an invalid ask payload", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await Effect.runPromise(
      runCli(["ask"], layersFor(await tempEventsPath()), () => Effect.succeed("not json")),
    );

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
