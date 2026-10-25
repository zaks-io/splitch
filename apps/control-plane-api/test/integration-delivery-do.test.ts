import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runIntegrationDeliverySweep } from "../src/integration-delivery-sweep";
import {
  alarmAt,
  appId,
  bump,
  coordinator,
  environmentA,
  environmentB,
  install,
  repo,
  setupDelivery,
} from "./integration-delivery-fixture";

const statuses = new Map<string, number>();
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + 3_600_000));
  await setupDelivery();
  statuses.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const status = statuses.get(url.hostname);
    if (status === undefined) throw new Error(`Unexpected outbound request: ${url.hostname}`);
    return new Response(null, { status });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("delivers Env B's newest version in one alarm independently of a failing Env A backlog", async () => {
  for (let i = 0; i < 30; i++) {
    await install("convex", `failing${i}`, environmentA);
    statuses.set(`failing${i}.convex.site`, i % 2 ? 500 : 404);
  }
  for (let version = 0; version < 10; version++) await bump(environmentA);
  for (let i = 0; i < 5; i++) {
    await install("convex", `healthy${i}`, environmentB);
    statuses.set(`healthy${i}.convex.site`, 200);
  }
  await bump(environmentB);
  await bump(environmentB);
  await coordinator(environmentA).wake(appId, environmentA);
  await coordinator(environmentB).wake(appId, environmentB);
  await Promise.all([
    runDurableObjectAlarm(coordinator(environmentA)),
    runDurableObjectAlarm(coordinator(environmentB)),
  ]);
  const rows = await env.DB.prepare(
    "SELECT last_delivered_version AS version FROM convex_installations WHERE environment_id = ?",
  )
    .bind(environmentB)
    .all<{ version: number }>();
  const version = await repo().convex.environmentVersion(envScope(appId, environmentB));
  expect(rows.results).toEqual(Array.from({ length: 5 }, () => ({ version })));
  expect(await alarmAt(environmentB)).toBeNull();
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM config_webhook_deliveries WHERE environment_id = ? AND state = 'pending'",
  )
    .bind(environmentA)
    .first<{ count: number }>();
  expect(pending?.count).toBeGreaterThan(0);
});

it.each(["convex", "cloudflare"] as const)(
  "schedules %s retry at its ladder time",
  async (provider) => {
    await install(provider, "retry", environmentB);
    if (provider === "convex") await bump(environmentB);
    const host = provider === "convex" ? "https://retry.convex.site" : "https://retry.workers.dev";
    statuses.set(new URL(host).hostname, 500);
    await coordinator(environmentB).wake(appId, environmentB);
    await runDurableObjectAlarm(coordinator(environmentB));
    const table =
      provider === "convex" ? "config_webhook_deliveries" : "cloudflare_config_deliveries";
    const row = await env.DB.prepare(
      `SELECT next_attempt_at AS retryAt, attempt_count AS attempts FROM ${table} WHERE state = 'pending'`,
    ).first<{ retryAt: string; attempts: number }>();
    expect(row?.attempts).toBe(1);
    expect(await alarmAt(environmentB)).toBe(Date.parse(row?.retryAt ?? ""));
    expect(Date.parse(row?.retryAt ?? "") - Date.now()).toBeLessThanOrEqual(1000);
  },
);

it("sweep recovers a dropped wake without outbound HTTP", async () => {
  await install("convex", "dropped", environmentB);
  await bump(environmentB);
  const fetcher = vi.spyOn(globalThis, "fetch");
  const waits: Promise<unknown>[] = [];
  await runIntegrationDeliverySweep(
    env,
    { cron: "* * * * *", scheduledTime: Date.now() } as ScheduledController,
    {
      waitUntil: (promise) => {
        waits.push(promise);
      },
    },
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(await alarmAt(environmentB)).not.toBeNull();
  await Promise.all(waits);
});

it("preserves a wake during an alarm and matches getAlarm's running-handler semantics", async () => {
  const stub = coordinator(environmentB);
  await stub.wake(appId, environmentB);
  await runInDurableObject(stub, async (instance) => {
    const original = instance.alarm.bind(instance);
    vi.spyOn(instance, "alarm").mockImplementationOnce(async () => {
      expect(await alarmAtInInstance(instance)).toBeNull();
      await instance.wake(appId, environmentB);
      await original();
    });
  });
  await runDurableObjectAlarm(stub);
  expect(await alarmAt(environmentB)).not.toBeNull();
});

async function alarmAtInInstance(instance: object) {
  return (Reflect.get(instance, "ctx") as DurableObjectState).storage.getAlarm();
}

it("rejects mismatched wake identities", async () => {
  const stub = coordinator(environmentB);
  await stub.wake(appId, environmentB);
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.wake(appId, environmentA)).rejects.toThrow("identity cannot change");
  });
});

it("catches a dependency failure, reports a fault, and reschedules in 30 s", async () => {
  const stub = coordinator(environmentB);
  await stub.wake(appId, environmentB);
  const logs = vi.spyOn(console, "error").mockImplementation(() => {});
  const before = Date.now();
  await runInDurableObject(stub, async (instance) => {
    const bindings = Reflect.get(instance, "env");
    const original = bindings.DB;
    bindings.DB = {
      prepare: () => {
        throw new Error("dependency failed");
      },
    };
    try {
      await expect(instance.alarm()).resolves.toBeUndefined();
    } finally {
      bindings.DB = original;
    }
  });
  expect(logs).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "integration_delivery_run_failed",
      appId,
      environmentId: environmentB,
    }),
  );
  // Invoke through the alarm runner too, with a missing persisted identity.
  await runInDurableObject(stub, (_instance, ctx) => ctx.storage.delete("identity"));
  await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
  expect(await alarmAt(environmentB)).toBeGreaterThanOrEqual(before + 30_000);
});
