import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isNotFoundError } from "../core/fs-errors.ts";

const Config = Schema.Record(Schema.String, Schema.Json);
const JsonArray = Schema.Array(Schema.Json);
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config));
const decodeJsonArray = Schema.decodeUnknownEffect(JsonArray);

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;
type ConfigRecord = Schema.Schema.Type<typeof Config>;

const PLUGIN_ENTRY = "./plugins/jev/index.ts";
const INSTRUCTION_ENTRY = "instructions/jev-routing.md";

export class OpenCodeInstallError extends Data.TaggedError("OpenCodeInstallError")<{
  readonly operation: "read" | "decode" | "copy" | "write" | "conflict";
  readonly path: string;
}> {}

export interface OpenCodeInstallResult {
  readonly pluginPath: string;
  readonly instructionPath: string;
  readonly configPath: string;
}

export const defaultOpenCodeConfigDir = (): string =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");

interface JsoncString {
  readonly text: string;
  readonly nextIndex: number;
}

const readJsoncString = (source: string, start: number): JsoncString => {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const current = source[index] ?? "";
    if (escaped) {
      escaped = false;
    } else if (current === "\\") {
      escaped = true;
    } else if (current === '"') {
      return { text: source.slice(start, index + 1), nextIndex: index + 1 };
    }
  }
  return { text: source.slice(start), nextIndex: source.length };
};

const skipJsoncLineComment = (source: string, start: number): number => {
  const newline = source.indexOf("\n", start + 2);
  return newline === -1 ? source.length : newline;
};

const skipJsoncBlockComment = (source: string, start: number): number => {
  const end = source.indexOf("*/", start + 2);
  return end === -1 ? source.length : end + 2;
};

const stripJsonc = (source: string): string => {
  const output: Array<string> = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (current === '"') {
      const value = readJsoncString(source, index);
      output.push(value.text);
      index = value.nextIndex;
    } else if (current === "/" && next === "/") {
      index = skipJsoncLineComment(source, index);
    } else if (current === "/" && next === "*") {
      index = skipJsoncBlockComment(source, index);
    } else {
      output.push(current);
      index += 1;
    }
  }
  return output.join("").replace(/,\s*([}\]])/gu, "$1");
};

const readOptional = (path: string): Effect.Effect<Option.Option<string>, OpenCodeInstallError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchIf(isNotFoundError, () => Effect.succeed(undefined)),
    Effect.map(Option.fromUndefinedOr),
    Effect.mapError(() => new OpenCodeInstallError({ operation: "read", path })),
  );

const addEntry = (entries: ReadonlyArray<JsonValue>, entry: string): ReadonlyArray<JsonValue> =>
  entries.some((value) => value === entry) ? entries : [...entries, entry];

const readRequired = (path: string): Effect.Effect<string, OpenCodeInstallError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: () => new OpenCodeInstallError({ operation: "read", path }),
  });

const installManagedFile = (
  sourcePath: string,
  targetPath: string,
  force: boolean,
): Effect.Effect<void, OpenCodeInstallError> =>
  Effect.gen(function* installManagedFileProgram() {
    const source = yield* readRequired(sourcePath);
    const target = yield* readOptional(targetPath);
    if (Option.isSome(target)) {
      if (target.value === source) return;
      if (!force) {
        return yield* Effect.fail(
          new OpenCodeInstallError({ operation: "conflict", path: targetPath }),
        );
      }
    }
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(targetPath), { recursive: true });
        await copyFile(sourcePath, targetPath);
      },
      catch: () => new OpenCodeInstallError({ operation: "copy", path: targetPath }),
    });
  });

export function installOpenCode(
  sourceRoot: string,
  configDir = defaultOpenCodeConfigDir(),
  force = false,
): Effect.Effect<OpenCodeInstallResult, OpenCodeInstallError> {
  return Effect.gen(function* installOpenCodeProgram() {
    const jsonPath = join(configDir, "opencode.json");
    const jsoncPath = join(configDir, "opencode.jsonc");
    const json = yield* readOptional(jsonPath);
    const jsonc = Option.isNone(json) ? yield* readOptional(jsoncPath) : Option.none<string>();
    const configPath = Option.isSome(json) ? jsonPath : Option.isSome(jsonc) ? jsoncPath : jsonPath;
    const raw = Option.isSome(json) ? json.value : Option.isSome(jsonc) ? jsonc.value : "{}";
    const config = yield* decodeConfig(stripJsonc(raw)).pipe(
      Effect.mapError(() => new OpenCodeInstallError({ operation: "decode", path: configPath })),
    );
    const plugins = yield* decodeJsonArray(config.plugins ?? []).pipe(
      Effect.mapError(() => new OpenCodeInstallError({ operation: "decode", path: configPath })),
    );
    const instructions = yield* decodeJsonArray(config.instructions ?? []).pipe(
      Effect.mapError(() => new OpenCodeInstallError({ operation: "decode", path: configPath })),
    );
    const nextConfig: ConfigRecord = {
      ...config,
      plugins: addEntry(plugins, PLUGIN_ENTRY),
      instructions: addEntry(instructions, INSTRUCTION_ENTRY),
    };
    const pluginPath = join(configDir, "plugins", "jev", "index.ts");
    const instructionPath = join(configDir, "instructions", "jev-routing.md");
    yield* installManagedFile(join(sourceRoot, "index.ts"), pluginPath, force);
    yield* installManagedFile(join(sourceRoot, "jev-routing.md"), instructionPath, force);
    yield* Effect.tryPromise({
      try: () => writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`),
      catch: () => new OpenCodeInstallError({ operation: "write", path: configPath }),
    });
    return { pluginPath, instructionPath, configPath };
  });
}
