import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isNotFoundError } from "../core/fs-errors.ts";

export type HarnessTarget = "opencode" | "pi" | "omp" | "claude-code";
type FileHarnessTarget = Exclude<HarnessTarget, "claude-code">;

export interface InstallRuntime {
  readonly homeDir: string;
  readonly bunPath: string;
  readonly cliEntry: string;
  readonly installPiAdapter: () => Effect.Effect<void, string>;
  readonly installClaudeMcp: () => Effect.Effect<void, string>;
}

type JsoncNode = JsoncObject | JsoncValue;

interface JsoncObject {
  readonly kind: "object";
  readonly start: number;
  readonly end: number;
  readonly closeStart: number;
  readonly properties: ReadonlyArray<JsoncProperty>;
}

interface JsoncValue {
  readonly kind: "value";
  readonly start: number;
  readonly end: number;
}

interface JsoncProperty {
  readonly key: string;
  readonly value: JsoncNode;
}

const piAdapterInstall = (): Effect.Effect<void, string> =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["pi", "install", "npm:pi-mcp-adapter"], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await child.exited) !== 0) throw new Error("pi adapter installation failed");
    },
    catch: () =>
      "Pi adapter install failed; ensure Pi is installed, then run `pi install npm:pi-mcp-adapter`.",
  });

const runCapturedCommand = (
  command: string,
  args: ReadonlyArray<string>,
): Effect.Effect<{ readonly exitCode: number; readonly output: string }, string> =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([command, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, output: `${stdout}\n${stderr}`.slice(-8_192) };
    },
    catch: () => `could not run ${command}`,
  });

const claudeCodeInstall = (bunPath: string, cliEntry: string): Effect.Effect<void, string> =>
  Effect.gen(function* installClaudeCodeMcpProgram() {
    const addArgs = [
      "mcp",
      "add",
      "--scope",
      "user",
      "jev-toolkit",
      "-e",
      "JEV_HARNESS=claude-code",
      "--",
      bunPath,
      cliEntry,
      "mcp",
    ];
    const added = yield* runCapturedCommand("claude", addArgs);
    if (added.exitCode === 0) return;
    if (!added.output.toLowerCase().includes("already exists")) {
      return yield* Effect.fail(
        "Claude Code MCP install failed; ensure the `claude` CLI is installed.",
      );
    }
    const removed = yield* runCapturedCommand("claude", [
      "mcp",
      "remove",
      "--scope",
      "user",
      "jev-toolkit",
    ]);
    if (removed.exitCode !== 0) {
      return yield* Effect.fail(
        "could not replace the existing user-scoped Jev MCP server in Claude Code",
      );
    }
    const replaced = yield* runCapturedCommand("claude", addArgs);
    if (replaced.exitCode !== 0) {
      return yield* Effect.fail(
        "Claude Code MCP replacement failed; rerun `jev install claude-code`.",
      );
    }
  });

const bunPath = Bun.which("bun") ?? "bun";
const cliEntry = Bun.fileURLToPath(new URL("./jev.ts", import.meta.url));

export const liveInstallRuntime: InstallRuntime = {
  homeDir: Bun.env.HOME ?? Bun.env.USERPROFILE ?? ".",
  bunPath,
  cliEntry,
  installPiAdapter: piAdapterInstall,
  installClaudeMcp: () => claudeCodeInstall(bunPath, cliEntry),
};

const configPath = (target: FileHarnessTarget, homeDir: string): string => {
  if (target === "pi") return `${homeDir}/.config/mcp/mcp.json`;
  if (target === "omp") return `${homeDir}/.omp/agent/mcp.json`;
  return `${homeDir}/.config/opencode/opencode.json`;
};

const serverEntry = (target: FileHarnessTarget, runtime: InstallRuntime) => {
  if (target === "pi") {
    return {
      command: runtime.bunPath,
      args: [runtime.cliEntry, "mcp"],
      env: { JEV_HARNESS: target },
    };
  }
  if (target === "omp") {
    return {
      type: "stdio",
      command: runtime.bunPath,
      args: [runtime.cliEntry, "mcp"],
      env: { JEV_HARNESS: target },
    };
  }
  return {
    type: "local",
    command: [runtime.bunPath, runtime.cliEntry, "mcp"],
    environment: { JEV_HARNESS: target },
  };
};

const stringEnd = (source: string, start: number): Option.Option<number> => {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") index += 2;
    else if (char === '"') return Option.some(index + 1);
    else index += 1;
  }
  return Option.none();
};

const commentEnd = (source: string, start: number): Option.Option<number> => {
  if (source[start + 1] === "/") {
    let end = start + 2;
    while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end += 1;
    return Option.some(end);
  }
  const close = source.indexOf("*/", start + 2);
  return close < 0 ? Option.none() : Option.some(close + 2);
};

const stripJsonComments = (source: string): Option.Option<string> => {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"') {
      const end = stringEnd(source, index);
      if (Option.isNone(end)) return Option.none();
      output += source.slice(index, end.value);
      index = end.value;
    } else if (char === "/" && (next === "/" || next === "*")) {
      const end = commentEnd(source, index);
      if (Option.isNone(end)) return Option.none();
      output += " ";
      index = end.value;
    } else {
      output += char;
      index += 1;
    }
  }
  return Option.some(output);
};

const stripTrailingCommas = (source: string): string => {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      output += char;
    } else if (char === ",") {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next] ?? "")) next += 1;
      if (source[next] !== "}" && source[next] !== "]") output += char;
    } else {
      output += char;
    }
  }
  return output;
};

const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

const isJsonObject = (source: string, target: FileHarnessTarget): boolean => {
  if (target === "pi") return Option.isSome(decodeJsonObject(source));
  const withoutComments = stripJsonComments(source);
  return Option.isSome(
    Option.flatMap(withoutComments, (json) => decodeJsonObject(stripTrailingCommas(json))),
  );
};

class JsoncParser {
  private offset = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parseRoot(): Option.Option<JsoncObject> {
    const root = this.parseValue();
    if (Option.isNone(root) || root.value.kind !== "object") return Option.none();
    this.skipTrivia();
    return this.offset === this.source.length ? Option.some(root.value) : Option.none();
  }

  private parseValue(): Option.Option<JsoncNode> {
    this.skipTrivia();
    const char = this.source[this.offset];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"') {
      const parsed = this.parseString();
      return Option.map(parsed, (string) => ({
        kind: "value",
        start: string.start,
        end: string.end,
      }));
    }
    return this.parsePrimitive();
  }

  private parseObject(): Option.Option<JsoncObject> {
    const start = this.offset;
    this.offset += 1;
    const properties: Array<JsoncProperty> = [];
    this.skipTrivia();
    if (this.source[this.offset] === "}") {
      const closeStart = this.offset;
      this.offset += 1;
      return Option.some({ kind: "object", start, end: this.offset, closeStart, properties });
    }
    while (this.offset < this.source.length) {
      const key = this.parseString();
      if (Option.isNone(key)) return Option.none();
      this.skipTrivia();
      if (this.source[this.offset] !== ":") return Option.none();
      this.offset += 1;
      const value = this.parseValue();
      if (Option.isNone(value)) return Option.none();
      properties.push({ key: key.value.value, value: value.value });
      this.skipTrivia();
      if (this.source[this.offset] === ",") {
        this.offset += 1;
        this.skipTrivia();
        if (this.source[this.offset] === "}") {
          const closeStart = this.offset;
          this.offset += 1;
          return Option.some({ kind: "object", start, end: this.offset, closeStart, properties });
        }
        continue;
      }
      if (this.source[this.offset] === "}") {
        const closeStart = this.offset;
        this.offset += 1;
        return Option.some({ kind: "object", start, end: this.offset, closeStart, properties });
      }
      return Option.none();
    }
    return Option.none();
  }

  private parseArray(): Option.Option<JsoncValue> {
    const start = this.offset;
    this.offset += 1;
    this.skipTrivia();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return Option.some({ kind: "value", start, end: this.offset });
    }
    while (this.offset < this.source.length) {
      const value = this.parseValue();
      if (Option.isNone(value)) return Option.none();
      this.skipTrivia();
      if (this.source[this.offset] === ",") {
        this.offset += 1;
        this.skipTrivia();
        if (this.source[this.offset] === "]") {
          this.offset += 1;
          return Option.some({ kind: "value", start, end: this.offset });
        }
        continue;
      }
      if (this.source[this.offset] === "]") {
        this.offset += 1;
        return Option.some({ kind: "value", start, end: this.offset });
      }
      return Option.none();
    }
    return Option.none();
  }

  private parseString(): Option.Option<{
    readonly value: string;
    readonly start: number;
    readonly end: number;
  }> {
    const start = this.offset;
    if (this.source[this.offset] !== '"') return Option.none();
    this.offset += 1;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset];
      if (char === "\\") this.offset += 2;
      else if (char === '"') {
        this.offset += 1;
        const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))(
          this.source.slice(start, this.offset),
        );
        return Option.map(decoded, (value) => ({ value, start, end: this.offset }));
      } else this.offset += 1;
    }
    return Option.none();
  }

  private parsePrimitive(): Option.Option<JsoncValue> {
    const start = this.offset;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset];
      if (
        char === undefined ||
        /\s/.test(char) ||
        char === "," ||
        char === "}" ||
        char === "]" ||
        char === "/"
      )
        break;
      this.offset += 1;
    }
    return this.offset === start
      ? Option.none()
      : Option.some({ kind: "value", start, end: this.offset });
  }

  private skipTrivia(): void {
    while (this.offset < this.source.length) {
      const char = this.source[this.offset];
      const next = this.source[this.offset + 1];
      if (char !== undefined && /\s/.test(char)) this.offset += 1;
      else if (char === "/" && next === "/") {
        this.offset += 2;
        while (
          this.offset < this.source.length &&
          this.source[this.offset] !== "\n" &&
          this.source[this.offset] !== "\r"
        ) {
          this.offset += 1;
        }
      } else if (char === "/" && next === "*") {
        const close = this.source.indexOf("*/", this.offset + 2);
        if (close < 0) this.offset = this.source.length;
        else this.offset = close + 2;
      } else return;
    }
  }
}

const findProperty = (object: JsoncObject, key: string): JsoncNode | undefined =>
  object.properties.findLast((property) => property.key === key)?.value;

const setProperty = (source: string, object: JsoncObject, key: string, value: string): string => {
  const existing = findProperty(object, key);
  if (existing !== undefined)
    return source.slice(0, existing.start) + value + source.slice(existing.end);
  const property = `${JSON.stringify(key)}: ${value}`;
  if (object.properties.length === 0) {
    return source.slice(0, object.closeStart) + property + source.slice(object.closeStart);
  }
  const lastValue = object.properties[object.properties.length - 1]?.value;
  if (lastValue === undefined) return source;
  return source.slice(0, lastValue.end) + `, ${property}` + source.slice(lastValue.end);
};

const updateConfig = (
  source: string,
  target: FileHarnessTarget,
  serializedEntry: string,
): Option.Option<string> => {
  if (!isJsonObject(source, target)) return Option.none();
  const root = new JsoncParser(source).parseRoot();
  if (Option.isNone(root)) return Option.none();
  const serversKey = target === "opencode" ? "mcp" : "mcpServers";
  const servers = findProperty(root.value, serversKey);
  if (servers === undefined) {
    return Option.some(
      setProperty(source, root.value, serversKey, `{ "jev-toolkit": ${serializedEntry} }`),
    );
  }
  if (servers.kind !== "object") return Option.none();
  return Option.some(setProperty(source, servers, "jev-toolkit", serializedEntry));
};

const initialConfig = (target: FileHarnessTarget, runtime: InstallRuntime): string => {
  const serversKey = target === "opencode" ? "mcp" : "mcpServers";
  return `${JSON.stringify(
    { [serversKey]: { "jev-toolkit": serverEntry(target, runtime) } },
    null,
    2,
  )}\n`;
};

const readConfig = (path: string): Effect.Effect<Option.Option<string>, string> =>
  Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (cause) => cause,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isNotFoundError, () => Effect.succeed(Option.none())),
    Effect.mapError(() => `could not read MCP config at ${path}`),
  );

const writeConfig = (path: string, source: string): Effect.Effect<void, string> =>
  Effect.tryPromise({
    try: async () => {
      const separator = path.lastIndexOf("/");
      const directory = separator < 0 ? "." : path.slice(0, separator) || "/";
      await Bun.$`mkdir -p ${directory}`.quiet();
      const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await Bun.write(temporaryPath, source, { mode: 0o600 });
        await Bun.$`mv -f ${temporaryPath} ${path}`.quiet();
      } finally {
        await Bun.$`rm -f ${temporaryPath}`.quiet();
      }
    },
    catch: () => `could not update MCP config at ${path}`,
  });

export const installHarness = (
  target: HarnessTarget,
  runtime: InstallRuntime = liveInstallRuntime,
): Effect.Effect<number, string> =>
  Effect.gen(function* installHarnessProgram() {
    if (target === "claude-code") {
      yield* runtime.installClaudeMcp();
      yield* Effect.sync(() =>
        console.log("Installed Jev MCP server for claude-code in user scope"),
      );
      return 0;
    }
    const path = configPath(target, runtime.homeDir);
    const existing = yield* readConfig(path);
    const serializedEntry = JSON.stringify(serverEntry(target, runtime));
    const updated = Option.match(existing, {
      onNone: () => Option.some(initialConfig(target, runtime)),
      onSome: (source) => updateConfig(source, target, serializedEntry),
    });
    if (Option.isNone(updated)) {
      return yield* Effect.fail(
        `invalid or incompatible MCP config at ${path}; it was left unchanged`,
      );
    }
    if (target === "pi") yield* runtime.installPiAdapter();
    yield* writeConfig(path, updated.value);
    yield* Effect.sync(() => console.log(`Installed Jev MCP server for ${target} in ${path}`));
    return 0;
  });
