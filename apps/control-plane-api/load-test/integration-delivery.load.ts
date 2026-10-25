import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import {
  appId,
  bump,
  coordinator,
  environmentA,
  environmentB,
  install,
  setupDelivery,
} from "../test/integration-delivery-fixture";

const DURATION_MS = 180_000;

it("measures healthy delivery latency under an unrelated 1,000-installation failing fan-out", async (context) => {
  await setupDelivery();
  for (let index = 0; index < 1000; index++)
    await install("convex", `failing${index}`, environmentA);
  for (let index = 0; index < 5; index++) await install("convex", `healthy${index}`, environmentB);
  let attemptedA = 0;
  let active = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const host = new URL(String(input)).hostname;
    if (host.startsWith("healthy")) {
      await delay(30, init?.signal);
      return new Response(null, { status: 200 });
    }
    const index = Number(/^failing(\d+)\./.exec(host)?.[1]);
    if (!Number.isInteger(index)) throw new Error(`Unexpected load-test receiver: ${host}`);
    if (host.endsWith(".convex.site")) attemptedA++;
    const latency = [100, 100, 1200, 4800, 5200][index % 5];
    if (latency === undefined) throw new Error("Load-test latency missing");
    await delay(latency, init?.signal);
    return new Response(null, { status: index % 2 ? 500 : 404 });
  });
  for (const environmentId of [environmentA, environmentB]) {
    await runInDurableObject(coordinator(environmentId), (instance) => {
      const alarm = instance.alarm.bind(instance);
      vi.spyOn(instance, "alarm").mockImplementation(async () => {
        active++;
        try {
          await alarm();
        } finally {
          active--;
        }
      });
    });
  }
  const startedAt = Date.now();
  const stopAt = startedAt + DURATION_MS;
  await Promise.all([produce(environmentA, 10_000, stopAt), produce(environmentB, 2000, stopAt)]);
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM config_webhook_deliveries WHERE environment_id = ? AND state != 'delivered'",
      )
        .bind(environmentB)
        .first<{ count: number }>();
      expect(row?.count).toBe(0);
    },
    { timeout: 10_000, interval: 100 },
  );
  const elapsedMs = Date.now() - startedAt;
  const rows = await env.DB.prepare(
    "SELECT created_at, delivered_at FROM config_webhook_deliveries WHERE environment_id = ? AND state = 'delivered'",
  )
    .bind(environmentB)
    .all<{ created_at: string; delivered_at: string }>();
  const latencies = rows.results
    .map((row) => timestamp(row.delivered_at) - timestamp(row.created_at))
    .sort((a, b) => a - b);
  const quantile = (fraction: number) => latencies[Math.ceil(latencies.length * fraction) - 1];
  context.task.meta.deliveryLoadResult = {
    durationMs: elapsedMs,
    healthyDeliveries: latencies.length,
    p50Ms: quantile(0.5),
    p99Ms: quantile(0.99),
    maxMs: latencies.at(-1),
    attemptedA,
    attemptsPerSecondA: attemptedA / (elapsedMs / 1000),
  };
  expect(latencies.length).toBe(450);
  // Let the in-flight pass finish, then park both local coordinators before pool teardown.
  for (const environmentId of [environmentA, environmentB]) {
    await runInDurableObject(coordinator(environmentId), (instance) => {
      Reflect.get(instance, "env").INTEGRATION_DELIVERY_MODE = "cron";
    });
  }
  await vi.waitFor(() => expect(active).toBe(0), { timeout: 65_000, interval: 100 });
  for (const environmentId of [environmentA, environmentB]) {
    await runInDurableObject(coordinator(environmentId), (_instance, ctx) =>
      ctx.storage.deleteAlarm(),
    );
  }
  vi.restoreAllMocks();
});

async function produce(environmentId: string, interval: number, stopAt: number) {
  while (Date.now() < stopAt) {
    await bump(environmentId);
    await coordinator(environmentId).wake(appId, environmentId);
    await delay(Math.min(interval, stopAt - Date.now()));
  }
}

function timestamp(value: string) {
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
