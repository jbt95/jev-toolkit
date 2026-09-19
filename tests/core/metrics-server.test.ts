import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { EventLogError, makeEventLog, type EventLogService } from "@/core/events.ts";
import { serveMeter } from "@/core/metrics.ts";
import { tempEventsPath } from "../helpers.ts";

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null) {
        reject(new Error("probe did not bind"));
        return;
      }
      // SAFETY: a TCP server listening on 127.0.0.1 reports an AddressInfo.
      const info = address as AddressInfo;
      probe.close(() => resolve(info.port));
    });
  });

const waitFor = async (url: string): Promise<Response> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`server did not start: ${url}`);
};

const failingLog: EventLogService = {
  append: () => Effect.void,
  read: () => Effect.fail(new EventLogError({ operation: "read" })),
  scan: () => Effect.fail(new EventLogError({ operation: "read" })),
};

describe("meter server", () => {
  it("serves health, metrics, and 404 from the event log", async () => {
    const log = makeEventLog(await tempEventsPath());
    await Effect.runPromise(
      log.append({
        _tag: "call",
        ts: new Date().toISOString(),
        harness: "cli",
        model: "jev-test",
        latencyMs: 5,
        status: "ok",
        questions: [{ id: "q", type: "noul" }],
      }),
    );
    const port = await freePort();
    const fiber = Effect.runFork(serveMeter(port, log));
    try {
      const health = await waitFor(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("ok");

      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      expect(await metrics.text()).toContain('jev_calls_total{harness="cli",status="ok"} 1');

      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("not found");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  it("responds 500 when the event log cannot be read", async () => {
    const port = await freePort();
    const fiber = Effect.runFork(serveMeter(port, failingLog));
    try {
      const metrics = await waitFor(`http://127.0.0.1:${port}/metrics`);
      expect(metrics.status).toBe(500);
      expect(await metrics.text()).toBe("event log read failed");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  it("fails with MeterError when the port is already in use", async () => {
    const log = makeEventLog(await tempEventsPath());
    const port = await freePort();
    const fiber = Effect.runFork(serveMeter(port, log));
    try {
      await waitFor(`http://127.0.0.1:${port}/health`);
      const exit = await Effect.runPromiseExit(serveMeter(port, log));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain("MeterError");
      }
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });
});
