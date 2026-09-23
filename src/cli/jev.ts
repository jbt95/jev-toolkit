import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { JevClient } from "../core/client.ts";
import { EventLog, EventLogLive } from "../core/events.ts";
import { JevClientSdkLive, sdkBaseURL } from "../core/sdk-client.ts";
import { apiEndpoint, eventsPath } from "../core/paths.ts";
import { Harness } from "../core/schema.ts";
import { createMcpDeps, serveMcp, type JevAsk } from "../mcp/server.ts";
import { installHarness, liveInstallRuntime, type InstallRuntime } from "./install.ts";

const USAGE = "usage: jev mcp | jev install <pi|opencode|omp|claude-code>";

export type CliServices = JevClient | EventLog;

const harnessFromEnv = (): Harness =>
  Option.fromUndefinedOr(Bun.env.JEV_HARNESS).pipe(
    Option.flatMap((value) => Schema.decodeUnknownOption(Harness)(value)),
    Option.getOrElse((): Harness => "script"),
  );

const runMcp = (): Effect.Effect<number, string, CliServices> =>
  Effect.gen(function* runMcpProgram() {
    const client = yield* JevClient;
    const log = yield* EventLog;
    const ask: JevAsk = (input) => client.ask(input);
    yield* Effect.tryPromise({
      try: () => serveMcp(createMcpDeps({ harness: harnessFromEnv(), ask, log })),
      catch: () => "mcp server failed",
    });
    return 0;
  });

const unknownCommand = (): Effect.Effect<number> =>
  Effect.sync(() => {
    console.error(USAGE);
    return 1;
  });

const installCommand = (
  argv: ReadonlyArray<string>,
  runtime: InstallRuntime,
): Effect.Effect<number, string> => {
  if (argv.length !== 2) return unknownCommand();
  switch (argv[1]) {
    case "pi":
      return installHarness("pi", runtime);
    case "opencode":
      return installHarness("opencode", runtime);
    case "omp":
      return installHarness("omp", runtime);
    case "claude-code":
      return installHarness("claude-code", runtime);
    default:
      return unknownCommand();
  }
};

const commandProgram = (
  argv: ReadonlyArray<string>,
  runtime: InstallRuntime,
): Effect.Effect<number, string, CliServices> => {
  switch (argv[0] ?? "") {
    case "mcp":
      return runMcp();
    case "install":
      return installCommand(argv, runtime);
    default:
      return unknownCommand();
  }
};

const reportFailure = (error: string): number => {
  console.error(error);
  return 1;
};

export function runCli(
  argv: ReadonlyArray<string>,
  layers: Layer.Layer<CliServices>,
  runtime: InstallRuntime = liveInstallRuntime,
): Effect.Effect<number> {
  return Effect.match(commandProgram(argv, runtime), {
    onFailure: reportFailure,
    onSuccess: (code) => code,
  }).pipe(Effect.provide(layers));
}

if (import.meta.main) {
  const apiKey = Option.fromUndefinedOr(Bun.env.TYPESAFE_API_KEY);
  const eventLog = EventLogLive(eventsPath());
  const layers = Layer.mergeAll(
    eventLog,
    JevClientSdkLive({ apiKey, baseURL: sdkBaseURL(apiEndpoint()) }).pipe(Layer.provide(eventLog)),
  );
  const code = await Effect.runPromise(runCli(Bun.argv.slice(2), layers));
  process.exitCode = code;
}
