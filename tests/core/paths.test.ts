import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  apiEndpoint,
  claudeProjectsDir,
  dataDir,
  eventsPath,
  loopStatePath,
  ompSessionsDir,
  opencodeDbPath,
  piSessionsDir,
} from "@/core/paths.ts";

const ENV_KEYS = ["JEV_DATA_DIR", "JEV_ENDPOINT", "JEV_OPENCODE_DB"] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("paths", () => {
  it("honors JEV_DATA_DIR and derives the log and loop-state paths", () => {
    process.env.JEV_DATA_DIR = "/tmp/jev-data";
    expect(dataDir()).toBe("/tmp/jev-data");
    expect(eventsPath()).toBe("/tmp/jev-data/events.jsonl");
    expect(loopStatePath()).toBe("/tmp/jev-data/loop-state.json");
  });

  it("falls back to the home data dir", () => {
    expect(dataDir()).toBe(join(homedir(), ".local", "share", "jev"));
    expect(eventsPath()).toBe(join(homedir(), ".local", "share", "jev", "events.jsonl"));
  });

  it("honors JEV_ENDPOINT and otherwise uses the TypeSafe API", () => {
    expect(apiEndpoint()).toBe("https://api.typesafe.ai/v1/systemone");
    process.env.JEV_ENDPOINT = "http://127.0.0.1:9/v1/systemone";
    expect(apiEndpoint()).toBe("http://127.0.0.1:9/v1/systemone");
  });

  it("honors JEV_OPENCODE_DB and otherwise uses the OpenCode store", () => {
    expect(opencodeDbPath()).toBe(join(homedir(), ".local", "share", "opencode", "opencode.db"));
    process.env.JEV_OPENCODE_DB = "/tmp/opencode.db";
    expect(opencodeDbPath()).toBe("/tmp/opencode.db");
  });

  it("derives the claude, pi, and omp session roots from home", () => {
    expect(claudeProjectsDir()).toBe(join(homedir(), ".claude", "projects"));
    expect(piSessionsDir()).toBe(join(homedir(), ".pi", "agent", "sessions"));
    expect(ompSessionsDir()).toBe(join(homedir(), ".omp", "agent", "sessions"));
  });
});
