import { homedir } from "node:os";
import { join } from "node:path";

/** Shared data dir for the event log and loop state (override: JEV_DATA_DIR). */
export function dataDir(): string {
  return process.env.JEV_DATA_DIR ?? join(homedir(), ".local", "share", "jev");
}

export function eventsPath(): string {
  return join(dataDir(), "events.jsonl");
}

export function apiEndpoint(): string {
  return process.env.JEV_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone";
}

export function opencodeDbPath(): string {
  return (
    process.env.JEV_OPENCODE_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db")
  );
}

export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function piSessionsDir(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

export function ompSessionsDir(): string {
  return join(homedir(), ".omp", "agent", "sessions");
}
