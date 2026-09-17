// Replay/measurement tool for reviewer triage.
//
//   node src/replay/review.ts --capture --date 2026-09-16 [--out DIR]
//   node src/replay/review.ts --score [--dir DIR]
//
// Capture reads reviewer sessions from the OpenCode DB (read-only) and writes
// one findings fixture per session using a documented heuristic: heading and
// bullet lines from the session's final assistant message, for sessions whose
// title mentions "review". Score runs `jev triage review --input <fixture>`
// per fixture and summarizes the routed classes.
//
// Outcome correlation (whether a following fix session touched the cited
// files) is session-level and left to the operator; this tool reports Jev
// classes only. It is a measurement aid, not a gate.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DB =
  process.env.JEV_OPENCODE_DB ?? join(homedir(), ".local/share/opencode/opencode.db");
const DEFAULT_OUT = join(homedir(), ".local/share/jev/review-fixtures");

const flagValue = (argv: ReadonlyArray<string>, name: string): Option.Option<string> => {
  const index = argv.indexOf(name);
  if (index === -1) return Option.none();
  return Option.fromUndefinedOr(argv[index + 1]);
};

const isFindingLine = (line: string): boolean =>
  /^(\s*[-*]\s+|\s*#{2,4}\s+|\s*\d+\.\s+)/u.test(line);

const toFinding = (line: string, index: number) => {
  const cleaned = line.replace(/^(\s*[-*]\s+|\s*#{2,4}\s+|\s*\d+\.\s+)/u, "").trim();
  const title = cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
  return {
    id: `f${index + 1}`,
    title,
    detail: cleaned.length > 0 ? cleaned : title,
  };
};

const SessionRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  directory: Schema.String,
});
const decodeSessionRow = Schema.decodeUnknownOption(SessionRow);

const MessageRow = Schema.Struct({ data: Schema.String });
const decodeMessageRow = Schema.decodeUnknownOption(MessageRow);

const MessageContent = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(MessageContent));

const Routed = Schema.Struct({
  blockers: Schema.Array(Schema.Json),
  cosmetic: Schema.Array(Schema.Json),
  questions: Schema.Array(Schema.Json),
  reviewSubstantive: Schema.Boolean,
  truncated: Schema.Boolean,
});
type Routed = Schema.Schema.Type<typeof Routed>;
const decodeRouted = Schema.decodeUnknownOption(Schema.fromJsonString(Routed));

type ClassifyResult =
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "routed"; readonly routed: Routed };

const openDb = (path: string): Effect.Effect<DatabaseSync, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(path, { readOnly: true })),
    (db) => Effect.sync(() => db.close()),
  );

type FixtureFinding = ReturnType<typeof toFinding>;

const sessionMessageTexts = (
  sessionID: string,
): Effect.Effect<ReadonlyArray<string>, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const db = yield* openDb(DEFAULT_DB);
    const messageRows = db
      .prepare(
        "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 5",
      )
      .all(sessionID);
    const texts: Array<string> = [];
    for (const messageRow of messageRows) {
      const decodedRow = decodeMessageRow(messageRow);
      if (Option.isNone(decodedRow)) continue;
      const parsed = decodeMessage(decodedRow.value.data);
      if (Option.isNone(parsed)) continue;
      for (const part of parsed.value.content) {
        const text = Option.fromUndefinedOr(part.text);
        if (Option.isSome(text)) texts.push(text.value);
      }
    }
    return texts;
  });

const findingsFromTexts = (texts: ReadonlyArray<string>): ReadonlyArray<FixtureFinding> =>
  texts
    .join("\n")
    .split("\n")
    .filter((line) => isFindingLine(line) && line.trim().length > 8)
    .slice(0, 20)
    .map(toFinding);

const writeFixture = (
  outDir: string,
  session: Schema.Schema.Type<typeof SessionRow>,
  findings: ReadonlyArray<FixtureFinding>,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: () =>
      writeFile(
        join(outDir, `${session.id.slice(0, 24)}.json`),
        JSON.stringify(
          { meta: { sessionID: session.id, title: session.title }, findings },
          null,
          2,
        ),
      ),
    catch: (cause) => cause,
  });

const captureSession = (
  session: Schema.Schema.Type<typeof SessionRow>,
  outDir: string,
): Effect.Effect<boolean, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    if (!session.title.toLowerCase().includes("review")) return false;
    const texts = yield* sessionMessageTexts(session.id);
    const findings = findingsFromTexts(texts);
    if (findings.length === 0) return false;
    yield* writeFixture(outDir, session, findings);
    return true;
  });

const capture = (date: string, outDir: string): Effect.Effect<void, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const start = Date.parse(`${date}T00:00:00.000Z`);
    const end = start + 24 * 60 * 60 * 1000;
    const db = yield* openDb(DEFAULT_DB);
    const sessionRows = db
      .prepare(
        "SELECT id, title, directory FROM session_v2 WHERE time_created >= ? AND time_created < ?",
      )
      .all(start, end);
    yield* Effect.tryPromise({
      try: () => mkdir(outDir, { recursive: true }),
      catch: (cause) => cause,
    });
    let captured = 0;
    for (const sessionRow of sessionRows) {
      const decodedSession = decodeSessionRow(sessionRow);
      if (Option.isNone(decodedSession)) continue;
      const wrote = yield* captureSession(decodedSession.value, outDir);
      if (wrote) captured += 1;
    }
    yield* Effect.sync(() => {
      console.log(`captured ${captured} reviewer sessions into ${outDir}`);
    });
  });

const classify = (inputPath: string): Effect.Effect<ClassifyResult> =>
  Effect.callback<ClassifyResult>((resume) => {
    execFile(
      "jev",
      ["triage", "review", "--input", inputPath],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure: ClassifyResult = {
            kind: "error",
            error: stderr.trim().length > 0 ? stderr.trim() : error.message,
          };
          resume(Effect.succeed(failure));
          return;
        }
        const parsed = decodeRouted(stdout);
        if (Option.isNone(parsed)) {
          const failure: ClassifyResult = {
            kind: "error",
            error: `unparseable output for ${inputPath}`,
          };
          resume(Effect.succeed(failure));
          return;
        }
        const routed: ClassifyResult = { kind: "routed", routed: parsed.value };
        resume(Effect.succeed(routed));
      },
    );
  });

const score = (dir: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const files = (yield* Effect.tryPromise({
      try: () => readdir(dir),
      catch: (cause) => cause,
    })).filter((name) => name.endsWith(".json"));
    let blockers = 0;
    let cosmetic = 0;
    let questions = 0;
    let truncated = 0;
    for (const file of files) {
      const result = yield* classify(join(dir, file));
      if (result.kind === "error") {
        yield* Effect.sync(() => {
          console.log(`${file}: ERROR ${result.error.slice(0, 120)}`);
        });
        continue;
      }
      const routed = result.routed;
      blockers += routed.blockers.length;
      cosmetic += routed.cosmetic.length;
      questions += routed.questions.length;
      if (routed.truncated) truncated += 1;
      yield* Effect.sync(() => {
        console.log(
          `${file}: blockers=${routed.blockers.length} cosmetic=${routed.cosmetic.length} questions=${routed.questions.length} substantive=${routed.reviewSubstantive} truncated=${routed.truncated}`,
        );
      });
    }
    const totals = `totals: fixtures=${files.length} blockers=${blockers} cosmetic=${cosmetic} questions=${questions} truncatedReviews=${truncated}`;
    yield* Effect.sync(() => {
      console.log(totals);
    });
  });

const argv = process.argv.slice(2);
let program: Effect.Effect<void, unknown>;
if (argv.includes("--capture")) {
  program = Effect.scoped(
    capture(
      flagValue(argv, "--date").pipe(Option.getOrElse(() => new Date().toISOString().slice(0, 10))),
      flagValue(argv, "--out").pipe(Option.getOrElse(() => DEFAULT_OUT)),
    ),
  );
} else if (argv.includes("--score")) {
  program = score(flagValue(argv, "--dir").pipe(Option.getOrElse(() => DEFAULT_OUT)));
} else {
  program = Effect.sync(() => {
    console.error(
      "usage: src/replay/review.ts --capture --date YYYY-MM-DD [--out DIR] | --score [--dir DIR]",
    );
    process.exitCode = 1;
  });
}
await Effect.runPromise(program);
