import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createServer } from "node:http";
import { join } from "node:path";
import { runCli } from "@/cli/jev.ts";
import { makeEventLog } from "@/core/events.ts";
import { apiResponse, cliLayers, freePort, tempEventsPath, writeTempFile } from "../helpers.ts";

const CheckView = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  detail: Schema.String,
});
type CheckView = Schema.Schema.Type<typeof CheckView>;

const DoctorReportView = Schema.Struct({ checks: Schema.Array(CheckView) });

const parseChecks = (output: string): ReadonlyArray<CheckView> =>
  Schema.decodeUnknownSync(DoctorReportView)(JSON.parse(output)).checks;

const checkNamed = (checks: ReadonlyArray<CheckView>, name: string): CheckView => {
  const found = checks.find((check) => check.name === name);
  if (found === undefined) throw new Error(`no ${name} check`);
  return found;
};

/** Serve fixed Prometheus text on a loopback port; returns the port and a closer. */
const serveMetrics = async (
  body: string,
  status = 200,
): Promise<{ readonly port: number; readonly close: () => Promise<void> }> => {
  const port = await freePort();
  const server = createServer((_request, response) => {
    response.writeHead(status, { "Content-Type": "text/plain; version=0.0.4" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

/** Run the doctor against a temp log and return its exit code and parsed checks. */
const runDoctorJson = async (
  path: string,
): Promise<{ readonly code: number; readonly checks: ReadonlyArray<CheckView> }> => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const code = await Effect.runPromise(
    runCli(
      ["doctor", "--json"],
      cliLayers(path, () => apiResponse({})),
    ),
  );
  return { code, checks: parseChecks(String(logSpy.mock.calls[0]?.[0])) };
};

/** One labeled session in the temp log, at the given timestamp. */
const seedLabel = async (path: string, ts: string): Promise<void> => {
  await Effect.runPromise(
    makeEventLog(path).append({
      _tag: "session_label",
      ts,
      harness: "opencode",
      sessionID: "sess-1",
      outcome: "shipped",
      friction: 1,
      waste: "none",
      taskType: "feature",
    }),
  );
};

/** Serve one meter exposition on the configured port for the duration of `body`. */
const withMeter = async (
  exposition: string,
  body: () => Promise<void>,
  status = 200,
): Promise<void> => {
  const meter = await serveMetrics(exposition, status);
  process.env.JEV_METER_PORT = String(meter.port);
  try {
    await body();
  } finally {
    await meter.close();
  }
};

const meterExposition = (lastEventSeconds: number, skippedLines = 0): string =>
  [
    `jev_meter_start_timestamp_seconds ${Math.round(Date.now() / 1000)}`,
    `jev_last_event_timestamp_seconds ${lastEventSeconds}`,
    `jev_log_lines_total{status="skipped"} ${skippedLines}`,
  ].join("\n");

const originalApiKey = process.env.TYPESAFE_API_KEY;
const originalOpencodeDb = process.env.JEV_OPENCODE_DB;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalApiKey;
  if (originalOpencodeDb === undefined) delete process.env.JEV_OPENCODE_DB;
  else process.env.JEV_OPENCODE_DB = originalOpencodeDb;
  delete process.env.JEV_METER_PORT;
  vi.restoreAllMocks();
});

describe("jev doctor", () => {
  it("fails the api_key check and warns on an empty log without a meter", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const path = await tempEventsPath();
    process.env.JEV_METER_PORT = String(await freePort());

    const { code, checks } = await runDoctorJson(path);

    expect(code).toBe(1);
    expect(checkNamed(checks, "api_key").status).toBe("fail");
    expect(checkNamed(checks, "event_log").status).toBe("warn");
    expect(checkNamed(checks, "meter").status).toBe("warn");
    expect(checkNamed(checks, "meter").detail).toContain("(unreachable;");
  });

  it("names a non-2xx meter answer as a status failure", async () => {
    process.env.TYPESAFE_API_KEY = "doctor-test-key";
    const path = await tempEventsPath();

    await withMeter(
      "meter is unwell",
      async () => {
        const { code, checks } = await runDoctorJson(path);

        expect(code).toBe(0);
        expect(checkNamed(checks, "meter").status).toBe("warn");
        expect(checkNamed(checks, "meter").detail).toContain("(status;");
      },
      503,
    );
  });

  it("fails when a session store cannot be read", async () => {
    process.env.TYPESAFE_API_KEY = "doctor-test-key";
    const path = await tempEventsPath();
    // A path under a regular file fails with ENOTDIR, not ENOENT: the store is
    // unreadable, which must surface instead of reading as absent.
    const blocker = await writeTempFile("blocker.txt", "not a directory");
    process.env.JEV_OPENCODE_DB = join(blocker, "opencode.db");
    process.env.JEV_METER_PORT = String(await freePort());

    const { code, checks } = await runDoctorJson(path);

    expect(code).toBe(1);
    expect(checkNamed(checks, "session_stores").status).toBe("fail");
    expect(checkNamed(checks, "session_stores").detail).toContain("cannot read opencode store");
  });

  it("reports an ok meter when the exposition is current", async () => {
    process.env.TYPESAFE_API_KEY = "doctor-test-key";
    const path = await tempEventsPath();
    const lastEventMs = Date.now() - 60_000;
    await seedLabel(path, new Date(lastEventMs).toISOString());

    await withMeter(meterExposition(Math.round(lastEventMs / 1000)), async () => {
      const { code, checks } = await runDoctorJson(path);

      expect(code).toBe(0);
      expect(checkNamed(checks, "api_key").status).toBe("ok");
      expect(checkNamed(checks, "event_log").status).toBe("ok");
      expect(checkNamed(checks, "event_log").detail).toContain("last event 1m ago");
      expect(checkNamed(checks, "meter").status).toBe("ok");
    });
  });

  it("warns when the meter serves a stale log view", async () => {
    process.env.TYPESAFE_API_KEY = "doctor-test-key";
    const path = await tempEventsPath();
    await seedLabel(path, "2026-09-21T00:00:00.000Z");

    await withMeter(meterExposition(0), async () => {
      const { code, checks } = await runDoctorJson(path);

      expect(code).toBe(0);
      expect(checkNamed(checks, "meter").status).toBe("warn");
      expect(checkNamed(checks, "meter").detail).toContain("stale");
    });
  });

  it("fails when the meter reports malformed log lines", async () => {
    process.env.TYPESAFE_API_KEY = "doctor-test-key";
    const path = await tempEventsPath();

    await withMeter(meterExposition(Math.round(Date.now() / 1000), 2), async () => {
      const { code, checks } = await runDoctorJson(path);

      expect(code).toBe(1);
      expect(checkNamed(checks, "meter").status).toBe("fail");
      expect(checkNamed(checks, "meter").detail).toContain("2 malformed log line(s)");
    });
  });
});
