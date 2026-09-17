import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { CliServices } from "@/cli/jev.ts";
import { JevClient, makeJevClient, type JevTransport } from "@/core/client.ts";
import { EventLogLive, makeEventLog, type EventLog } from "@/core/events.ts";
import { LoopGuardLive } from "@/core/loops.ts";

const execFileAsync = promisify(execFile);

/** Temp directory for tests. */
export const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "jev-test-"));

/** Temp events.jsonl path for tests. */
export const tempEventsPath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "jev-test-")), "events.jsonl");

/** EventLog layer backed by a temp file (test composition root). */
export const TestEventLog = (path: string): Layer.Layer<EventLog> => EventLogLive(path);

/** JevTransport fake over an injected send function. */
export const makeTestTransport = (send: JevTransport["send"]): JevTransport => ({ send });

/** One TypeSafe wire answer, matching the client's decode contract. */
export type WireAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities?: Readonly<Record<string, number>>;
    }
  | {
      readonly type: "score";
      readonly score: number;
      readonly confidence: number;
      readonly probabilities?: Readonly<Record<string, number>>;
    };

/** One TypeSafe wire response body. */
export interface WireResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, WireAnswer>>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/** A TypeSafe-shaped success body. */
export const apiResponse = (answers: Readonly<Record<string, WireAnswer>>): WireResponse => ({
  model: "jev-test",
  answers,
  usage: { input_tokens: 5, output_tokens: 2 },
});

/** Transport fake that answers every call with a typed wire response. */
export const makeJsonTransport = (respond: (body: string) => WireResponse): JevTransport =>
  makeTestTransport((body) => Effect.succeed(JSON.stringify(respond(body))));

const WireQuestions = Schema.Struct({ questions: Schema.Record(Schema.String, Schema.Json) });
const decodeWireQuestions = Schema.decodeUnknownOption(Schema.fromJsonString(WireQuestions));

/** Question ids from a request body, decoded at the boundary. */
export const requestQuestionIds = (body: string): ReadonlyArray<string> => {
  const decoded = decodeWireQuestions(body);
  return Option.isSome(decoded) ? Object.keys(decoded.value.questions) : [];
};

/** CLI service layers with a wire-response fake, for runCli tests. */
export const cliLayers = (
  path: string,
  respond: (body: string) => WireResponse,
  apiKey = "test-key",
): Layer.Layer<CliServices> =>
  Layer.mergeAll(
    EventLogLive(path),
    LoopGuardLive(join(path, "..", "loop-state.json")),
    Layer.succeed(
      JevClient,
      makeJevClient({
        apiKey: Option.some(apiKey),
        transport: makeJsonTransport(respond),
        log: makeEventLog(path),
      }),
    ),
  );

/** Write a file into a fresh temp dir and return its path. */
export const writeTempFile = async (name: string, content: string): Promise<string> => {
  const path = join(await tempDir(), name);
  await writeFile(path, content);
  return path;
};

export interface OpencodeDb {
  readonly path: string;
  readonly insertMessage: (
    id: string,
    type: "user" | "assistant",
    timeCreated: number,
    text: string,
    sessionID?: string,
  ) => void;
  readonly insertAsk: (
    id: string,
    sessionID: string,
    timeCreated: number,
    questionIDs: ReadonlyArray<string>,
  ) => void;
  readonly insertSession: (id: string, title: string, timeCreated: number) => void;
}

/** Minimal OpenCode store: session_v2 + session_message, enough for audit/label/replay. */
export const makeOpencodeDb = async (): Promise<OpencodeDb> => {
  const path = join(await tempDir(), "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, cost REAL);
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `);
  db.close();
  const withDb = <T>(fn: (db: DatabaseSync) => T): T => {
    const handle = new DatabaseSync(path);
    try {
      return fn(handle);
    } finally {
      handle.close();
    }
  };
  return {
    path,
    insertMessage: (id, type, timeCreated, text, sessionID = "sess-1") =>
      withDb((handle) => {
        const payload = type === "user" ? { text } : { content: [{ type: "text", text }] };
        handle
          .prepare(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(id, sessionID, type, Date.now(), timeCreated, timeCreated, JSON.stringify(payload));
      }),
    insertAsk: (id, sessionID, timeCreated, questionIDs) =>
      withDb((handle) => {
        const code = `return tools.jev.typesafe_ask({ questions: { ${questionIDs
          .map((questionID) => `${questionID}: {}`)
          .join(", ")} } });`;
        const payload = {
          content: [{ type: "tool", name: "execute", state: { input: { code } } }],
        };
        handle
          .prepare(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            sessionID,
            "assistant",
            Date.now(),
            timeCreated,
            timeCreated,
            JSON.stringify(payload),
          );
      }),
    insertSession: (id, title, timeCreated) =>
      withDb((handle) => {
        handle
          .prepare(
            "INSERT INTO session_v2 (id, title, directory, time_created, cost) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, title, "/tmp/project", timeCreated, 0);
      }),
  };
};

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Install a fake `jev` executable whose stdout is driven by exact-argv responses. */
export const installFakeJev = async (
  responses: Readonly<Record<string, string>>,
): Promise<{ readonly binDir: string; readonly logPath: string }> => {
  const dir = await tempDir();
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const logPath = join(dir, "calls.log");
  const branches = Object.entries(responses)
    .map(
      ([key, value]) => `if [ "$*" = ${shQuote(key)} ]; then printf '%s\\n' ${shQuote(value)}; fi`,
    )
    .join("\n");
  const script = `#!/bin/sh\nprintf '%s\\n' "\${JEV_HARNESS:-unset} $*" >> ${shQuote(logPath)}\ncat >/dev/null 2>&1 &\n${branches}\nexit 0\n`;
  await writeFile(join(binDir, "jev"), script, { mode: 0o755 });
  return { binDir, logPath };
};

/** Install a `jev` that always exits 1, draining stdin, for failure-path tests. */
export const installFailingJev = async (): Promise<{
  readonly binDir: string;
  readonly logPath: string;
}> => {
  const dir = await tempDir();
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const logPath = join(dir, "calls.log");
  const script = `#!/bin/sh\nprintf '%s\\n' "\${JEV_HARNESS:-unset} $*" >> ${shQuote(logPath)}\ncat >/dev/null 2>&1 &\nexit 1\n`;
  await writeFile(join(binDir, "jev"), script, { mode: 0o755 });
  return { binDir, logPath };
};

/** Run fn with `dir` prepended to PATH, restoring PATH afterwards. */
export const withPath = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = previous;
  }
};

export interface FakeApi {
  readonly url: string;
  readonly requests: Array<string>;
  readonly close: () => Promise<void>;
  readonly respondWith: (body: (requestBody: string) => string) => void;
}

/** Local HTTP server standing in for the TypeSafe API (127.0.0.1 only). */
export const startFakeApi = async (initial?: (requestBody: string) => string): Promise<FakeApi> => {
  const requests: Array<string> = [];
  let responder = initial ?? (() => JSON.stringify(apiResponse({})));
  const server: Server = createServer((request, response) => {
    const chunks: Array<string> = [];
    request.on("data", (chunk) => chunks.push(String(chunk)));
    request.on("end", () => {
      const body = chunks.join("");
      requests.push(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(responder(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null) throw new Error("fake api did not bind");
  // SAFETY: a TCP server listening on 127.0.0.1 reports an AddressInfo.
  const info = address as AddressInfo;
  return {
    url: `http://127.0.0.1:${info.port}/v1/systemone`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    respondWith: (body) => {
      responder = body;
    },
  };
};

/** Create a throwaway git repository with one commit. */
export const makeGitRepo = async (): Promise<string> => {
  const dir = await tempDir();
  await execFileAsync("git", ["init", "-q", dir]);
  await writeFile(join(dir, "a.txt"), "a\n");
  await execFileAsync("git", ["-C", dir, "add", "."]);
  await execFileAsync("git", [
    "-C",
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-q",
    "-m",
    "feat(parser): add a file",
  ]);
  return dir;
};
