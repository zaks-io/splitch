import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import worker from "../src/index.js";

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY NOT NULL, is_provisional INTEGER DEFAULT 0 NOT NULL, demo_expires_at TEXT)",
  );
});

describe("Control Plane API scheduled credential cache backfill", () => {
  it("dispatches through its Durable Object binding", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const getByName = vi.fn(() => ({ fetch }));

    await runScheduled({ getByName });

    expect(getByName).toHaveBeenCalledWith("schema-v1");
    expect(fetch).toHaveBeenCalledWith("https://backfill/run", { method: "POST" });
  });
});

async function runScheduled(credentialCacheBackfill: {
  getByName: () => { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
}): Promise<void> {
  const waits: Promise<unknown>[] = [];
  worker.scheduled?.(
    {
      cron: "0 8 * * *",
      scheduledTime: Date.UTC(2026, 6, 3, 8, 0, 0),
      noRetry: vi.fn(),
    } as ScheduledController,
    {
      ...env,
      CREDENTIAL_CACHE_BACKFILL: credentialCacheBackfill,
      SPLITCH_PLATFORM_TARGET: "local",
    } as ControlPlaneApiEnv,
    {
      waitUntil: (promise) => waits.push(promise),
    } as unknown as ExecutionContext,
  );
  await Promise.all(waits);
}
