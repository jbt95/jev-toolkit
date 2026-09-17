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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DB =
  process.env.JEV_OPENCODE_DB ?? join(homedir(), ".local/share/opencode/opencode.db");
const DEFAULT_OUT = join(homedir(), ".local/share/jev/review-fixtures");

const flagValue = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
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

const capture = async (date: string, outDir: string): Promise<void> => {
  const start = Date.parse(`${date}T00:00:00.000Z`);
  const end = start + 24 * 60 * 60 * 1000;
  const db = new DatabaseSync(DEFAULT_DB, { readOnly: true });
  let sessionRows;
  try {
    sessionRows = db
      .prepare(
        "SELECT id, title, directory FROM session_v2 WHERE time_created >= ? AND time_created < ?",
      )
      .all(start, end);
  } finally {
    db.close();
  }
  await mkdir(outDir, { recursive: true });
  let captured = 0;
  for (const sessionRow of sessionRows) {
    const decodedSession = decodeSessionRow(sessionRow);
    if (Option.isNone(decodedSession)) continue;
    const session = decodedSession.value;
    if (!session.title.toLowerCase().includes("review")) continue;
    const db2 = new DatabaseSync(DEFAULT_DB, { readOnly: true });
    let messageRows;
    try {
      messageRows = db2
        .prepare(
          "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 5",
        )
        .all(session.id);
    } finally {
      db2.close();
    }
    const texts: Array<string> = [];
    for (const messageRow of messageRows) {
      const decodedRow = decodeMessageRow(messageRow);
      if (Option.isNone(decodedRow)) continue;
      const parsed = decodeMessage(decodedRow.value.data);
      if (Option.isNone(parsed)) continue;
      for (const part of parsed.value.content) {
        if (part.text !== undefined) texts.push(part.text);
      }
    }
    const findings = texts
      .join("\n")
      .split("\n")
      .filter((line) => isFindingLine(line) && line.trim().length > 8)
      .slice(0, 20)
      .map(toFinding);
    if (findings.length === 0) continue;
    await writeFile(
      join(outDir, `${session.id.slice(0, 24)}.json`),
      JSON.stringify({ meta: { sessionID: session.id, title: session.title }, findings }, null, 2),
    );
    captured += 1;
  }
  console.log(`captured ${captured} reviewer sessions into ${outDir}`);
};

const classify = (inputPath: string): Promise<ClassifyResult> =>
  new Promise((resolve) => {
    execFile(
      "jev",
      ["triage", "review", "--input", inputPath],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          resolve({
            kind: "error",
            error: stderr.trim().length > 0 ? stderr.trim() : error.message,
          });
          return;
        }
        const parsed = decodeRouted(stdout);
        if (Option.isNone(parsed)) {
          resolve({ kind: "error", error: `unparseable output for ${inputPath}` });
          return;
        }
        resolve({ kind: "routed", routed: parsed.value });
      },
    );
  });

const score = async (dir: string): Promise<void> => {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  let blockers = 0;
  let cosmetic = 0;
  let questions = 0;
  let truncated = 0;
  for (const file of files) {
    const result = await classify(join(dir, file));
    if (result.kind === "error") {
      console.log(`${file}: ERROR ${result.error.slice(0, 120)}`);
      continue;
    }
    const routed = result.routed;
    blockers += routed.blockers.length;
    cosmetic += routed.cosmetic.length;
    questions += routed.questions.length;
    if (routed.truncated) truncated += 1;
    console.log(
      `${file}: blockers=${routed.blockers.length} cosmetic=${routed.cosmetic.length} questions=${routed.questions.length} substantive=${routed.reviewSubstantive} truncated=${routed.truncated}`,
    );
  }
  console.log(
    `totals: fixtures=${files.length} blockers=${blockers} cosmetic=${cosmetic} questions=${questions} truncatedReviews=${truncated}`,
  );
};

const argv = process.argv.slice(2);
if (argv.includes("--capture")) {
  await capture(
    flagValue(argv, "--date") ?? new Date().toISOString().slice(0, 10),
    flagValue(argv, "--out") ?? DEFAULT_OUT,
  );
} else if (argv.includes("--score")) {
  await score(flagValue(argv, "--dir") ?? DEFAULT_OUT);
} else {
  console.error(
    "usage: src/replay/review.ts --capture --date YYYY-MM-DD [--out DIR] | --score [--dir DIR]",
  );
  process.exitCode = 1;
}
