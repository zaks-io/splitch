import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runControlPlaneScheduled } from "../src/scheduled";
import { bump, environmentB, install, setupDelivery } from "./integration-delivery-fixture";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 3_600_000);
  await setupDelivery();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function cron() {
  const waits: Promise<unknown>[] = [];
  runControlPlaneScheduled(
    { cron: "* * * * *", scheduledTime: Date.now() } as ScheduledController,
    { ...env, INTEGRATION_DELIVERY_MODE: "cron" },
    { waitUntil: (promise) => waits.push(promise) } as unknown as ExecutionContext,
  );
  await Promise.all(waits);
}

it("cron claims 25 concurrent Cloudflare sends and accepts responses slower than five seconds", async () => {
  for (let i = 0; i < 26; i++) await install("cloudflare", `legacy${i}`, environmentB);
  let active = 0;
  let peak = 0;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    expect(init?.signal).toBeUndefined();
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5500));
    active--;
    return new Response(null, { status: 200, headers: { "splitch-environment-version": "1" } });
  });
  await cron();
  expect(fetcher).toHaveBeenCalledTimes(25);
  expect(peak).toBe(25);
  const rows = await env.DB.prepare(
    "SELECT state, COUNT(*) AS count FROM cloudflare_config_deliveries GROUP BY state",
  ).all();
  expect(rows.results).toEqual([
    { state: "delivered", count: 25 },
    { state: "pending", count: 1 },
  ]);
});

it("cron uses the claim clock for both providers' retry timestamps", async () => {
  await install("convex", "retryconvex", environmentB);
  await install("cloudflare", "retrycloudflare", environmentB);
  await bump(environmentB);
  const claimedAt = Date.now();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    vi.setSystemTime(claimedAt + 10_000);
    return new Response(null, { status: 500 });
  });
  await cron();
  for (const table of ["config_webhook_deliveries", "cloudflare_config_deliveries"]) {
    const row = await env.DB.prepare(
      `SELECT next_attempt_at AS retryAt FROM ${table} WHERE attempt_count = 1`,
    ).first<{ retryAt: string }>();
    expect(row?.retryAt).toBe(new Date(claimedAt + 1000).toISOString());
  }
});
