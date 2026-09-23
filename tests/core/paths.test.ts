import { afterEach, describe, expect, it } from "bun:test";
import { apiEndpoint, dataDir, eventsPath } from "@/core/paths.ts";
import { joinPath } from "../helpers.ts";

const ENV_KEYS = ["JEV_DATA_DIR", "JEV_ENDPOINT"] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete Bun.env[key];
});

describe("paths", () => {
  it("honors JEV_DATA_DIR and derives the event log path", () => {
    Bun.env.JEV_DATA_DIR = "/tmp/jev-data";
    expect(dataDir()).toBe("/tmp/jev-data");
    expect(eventsPath()).toBe("/tmp/jev-data/events.jsonl");
  });

  it("falls back to the home data dir", () => {
    const home = Bun.env.HOME ?? Bun.env.USERPROFILE ?? ".";
    const expected = joinPath(home, ".local", "share", "jev");
    expect(dataDir()).toBe(expected);
    expect(eventsPath()).toBe(joinPath(expected, "events.jsonl"));
  });

  it("honors JEV_ENDPOINT and otherwise uses the TypeSafe API", () => {
    expect(apiEndpoint()).toBe("https://api.typesafe.ai/v1/systemone");
    Bun.env.JEV_ENDPOINT = "http://127.0.0.1:9/v1/systemone";
    expect(apiEndpoint()).toBe("http://127.0.0.1:9/v1/systemone");
  });
});
