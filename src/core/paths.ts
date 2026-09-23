const homeDir = Bun.env.HOME ?? Bun.env.USERPROFILE ?? ".";

/** Shared data dir for the event log (override: JEV_DATA_DIR). */
export function dataDir(): string {
  return Bun.env.JEV_DATA_DIR ?? `${homeDir}/.local/share/jev`;
}

export function eventsPath(): string {
  return `${dataDir()}/events.jsonl`;
}

export function apiEndpoint(): string {
  return Bun.env.JEV_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone";
}
