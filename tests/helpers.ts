import * as Schema from "effect/Schema";
import type { JevTransport } from "@/core/client.ts";

export const joinPath = (base: string, ...parts: ReadonlyArray<string>): string =>
  `${base.replace(/[\\/]+$/, "")}/${parts.map((part) => part.replace(/^[\\/]+/, "")).join("/")}`;

export const tempDir = async (): Promise<string> => {
  const root = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
  const path = joinPath(root, `jev-test-${crypto.randomUUID()}`);
  await Bun.$`mkdir -p ${path}`.quiet();
  return path;
};

export const tempEventsPath = async (): Promise<string> =>
  joinPath(await tempDir(), "events.jsonl");

export const makeDirectory = async (path: string): Promise<void> => {
  await Bun.$`mkdir -p ${path}`.quiet();
};

export const removeTree = async (path: string): Promise<void> => {
  await Bun.$`rm -rf ${path}`.quiet();
};

export const readText = (path: string): Promise<string> => Bun.file(path).text();

export const writeText = async (path: string, text: string): Promise<void> => {
  await Bun.write(path, text);
};

export const appendText = async (path: string, text: string): Promise<void> => {
  await Bun.$`printf "%s" ${text} >> ${path}`.quiet();
};

export const makeTestTransport = (send: JevTransport["send"]): JevTransport => ({ send });

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

export interface WireResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, WireAnswer>>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

const WireQuestions = Schema.Struct({ questions: Schema.Record(Schema.String, Schema.Json) });
const decodeWireQuestions = Schema.decodeUnknownOption(Schema.fromJsonString(WireQuestions));

export const requestQuestionIds = (body: string): ReadonlyArray<string> => {
  const decoded = decodeWireQuestions(body);
  return decoded._tag === "Some" ? Object.keys(decoded.value.questions) : [];
};

export interface FakeApi {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** Local HTTP server standing in for the TypeSafe API (127.0.0.1 only). */
export const startFakeApi = async (initial: (requestBody: string) => string): Promise<FakeApi> => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      new Response(initial(await request.text()), {
        headers: { "Content-Type": "application/json" },
      }),
  });
  return {
    url: `${server.url.href}v1/systemone`,
    close: async () => server.stop(true),
  };
};
