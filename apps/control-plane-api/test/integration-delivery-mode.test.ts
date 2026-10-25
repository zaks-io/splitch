import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatchCloudflarePushes } from "../src/cloudflare-push-dispatch";
import { dispatchConvexWebhooks } from "../src/convex-webhook-dispatch";
import {
  appId,
  bump,
  coordinator,
  environmentB,
  install,
  repo,
  setupDelivery,
} from "./integration-delivery-fixture";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + 3_600_000));
  await setupDelivery();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("real workerd alarm consumes its alarm and exposes an alarm set during the handler", async () => {
  vi.useRealTimers();
  const stub = coordinator(environmentB);
  let observed:
    | { before: number | null; after: number | null; retained: number | null }
    | undefined;
  await runInDurableObject(stub, (instance, ctx) => {
    const alarm = instance.alarm.bind(instance);
    vi.spyOn(instance, "alarm").mockImplementationOnce(async () => {
      const before = await ctx.storage.getAlarm();
      const next = Date.now() + 60_000;
      await ctx.storage.setAlarm(next);
      const after = await ctx.storage.getAlarm();
      await alarm();
      observed = { before, after, retained: await ctx.storage.getAlarm() };
    });
  });
  await stub.wake(appId, environmentB);
  await vi.waitFor(() => {
    expect(observed?.before).toBeNull();
    expect(observed?.after).toBeGreaterThan(Date.now());
    expect(observed?.retained).toBe(observed?.after);
  });
  await runInDurableObject(stub, (_instance, ctx) => ctx.storage.deleteAlarm());
});

it.each(["convex", "cloudflare"] as const)(
  "switching from cron with %s rows leased does not double send",
  async (provider) => {
    await install(provider, "leased", environmentB);
    if (provider === "convex") await bump(environmentB);
    const scope = envScope(appId, environmentB);
    const rows = await repo()[provider].claimDueDeliveries(
      new Date().toISOString(),
      "cron",
      new Date(Date.now() + 30_000).toISOString(),
      25,
    );
    expect(rows).toHaveLength(1);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const stub = coordinator(environmentB);
    await stub.wake(appId, environmentB);
    await runDurableObjectAlarm(stub);
    expect(fetcher).not.toHaveBeenCalled();
    // The old cron claimant still owns the row until acknowledgment or lease expiry.
    const row = rows[0];
    if (!row) throw new Error("Expected a leased delivery");
    await repo()[provider].finishDelivery(row.deliveryId, "cron", {
      state: "delivered",
      now: new Date().toISOString(),
      appliedVersion: 1,
    });
    const deps = {
      repo: repo(),
      scope,
      webhookKek: env.CONVEX_WEBHOOK_KEK,
      secretKek: env.INTEGRATION_SECRET_KEK,
    };
    expect(
      await (provider === "convex" ? dispatchConvexWebhooks(deps) : dispatchCloudflarePushes(deps)),
    ).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("a stale coordinator alarm sends nothing after switching to cron", async () => {
  await install("cloudflare", "mode", environmentB);
  const stub = coordinator(environmentB);
  const fetcher = vi.spyOn(globalThis, "fetch");
  await stub.wake(appId, environmentB);
  await runInDurableObject(stub, async (instance) => {
    const bindings = Reflect.get(instance, "env");
    const mode = bindings.INTEGRATION_DELIVERY_MODE;
    bindings.INTEGRATION_DELIVERY_MODE = "cron";
    try {
      await instance.alarm();
    } finally {
      bindings.INTEGRATION_DELIVERY_MODE = mode;
    }
  });
  expect(fetcher).not.toHaveBeenCalled();
});
