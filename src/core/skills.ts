import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFoundError } from "./fs-errors.ts";
import { clip, redact } from "./text.ts";

/** One routable skill: the name is the answer value, the description its criterion. */
export interface SkillCandidate {
  readonly name: string;
  readonly description: string;
}

export class SkillCatalogError extends Data.TaggedError("SkillCatalogError")<{
  readonly source: string;
}> {}

const DESCRIPTION_CHARS = 300;

/** A catalog file: `[{ "name": ..., "description": ... }]`. */
const CatalogFile = Schema.Array(
  Schema.Struct({ name: Schema.NonEmptyString, description: Schema.NonEmptyString }),
);
const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(CatalogFile));

const NAME_LINE = /^name:[ \t]*/mu;
const DESCRIPTION_LINE = /^description:[ \t]*/mu;
/** The next top-level key after a value; indented continuation lines do not match. */
const NEXT_KEY = /\n[a-zA-Z_-]+:[ \t]/u;

const normalizeValue = (raw: string): string =>
  raw
    .replace(/^[>|][-+]?[ \t]*/u, "")
    .replace(/\s+/gu, " ")
    .trim();

/** Text of a top-level key, folded: YAML block scalars and wrapped lines included. */
const valueOf = (block: string, key: RegExp): string | undefined => {
  const match = key.exec(block);
  if (match === null) return undefined;
  const rest = block.slice(match.index + match[0].length);
  const next = NEXT_KEY.exec(rest);
  const raw = next === null ? rest : rest.slice(0, next.index);
  const value = normalizeValue(raw).replace(/^["']|["']$/gu, "");
  return value.length === 0 ? undefined : value;
};

/** The fields this reader takes from a SKILL.md front matter block. */
interface SkillFrontMatter {
  readonly name?: string;
  readonly description?: string;
}

/** `name` and `description` from a SKILL.md front matter block. */
const frontMatter = (raw: string): SkillFrontMatter => {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = raw.slice(3, end);
  return { name: valueOf(block, NAME_LINE), description: valueOf(block, DESCRIPTION_LINE) };
};

/** One candidate per `SKILL.md` under `root`, named by its front matter or folder. */
const readSkillDir = async (root: string): Promise<ReadonlyArray<SkillCandidate>> => {
  const entries = await readdir(root, { withFileTypes: true });
  const skills: Array<SkillCandidate> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = await readFile(join(root, entry.name, "SKILL.md"), "utf8").catch(() => "");
    const { name, description } = frontMatter(raw);
    if (description === undefined || description.length === 0) continue;
    skills.push({
      name: name ?? entry.name,
      description: clip(redact(description), DESCRIPTION_CHARS),
    });
  }
  return skills;
};

/**
 * Read a candidate catalog from a JSON file or a directory of `SKILL.md`
 * folders. A missing source is an empty catalog; other failures surface.
 */
export const readSkillCatalog = (
  source: string,
  kind: "file" | "dir",
): Effect.Effect<ReadonlyArray<SkillCandidate>, SkillCatalogError> =>
  Effect.tryPromise({
    try: async () => {
      if (kind === "dir") return await readSkillDir(source);
      const decoded = decodeCatalog(await readFile(source, "utf8"));
      return Option.isSome(decoded) ? decoded.value : [];
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchIf(isNotFoundError, () => Effect.succeed([])),
    Effect.mapError(() => new SkillCatalogError({ source })),
  );
