import { envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatchCloudflarePushes } from "../src/cloudflare-push-dispatch";
import { dispatchConvexWebhooks } from "../src/convex-webhook-dispatch";
import { coordinatorDeliveryPolicy, cronDeliveryPolicy } from "../src/integration-delivery-limits";
import {
  appId,
  bump,
  environmentB,
  install,
  repo,
  setupDelivery,
} from "./integration-delivery-fixture";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 3_600_000);
  await setupDelivery();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const cases = [
  ["convex", "coordinator"],
  ["cloudflare", "coordinator"],
  ["convex", "cron"],
  ["cloudflare", "cron"],
] as const;

async function prepare(provider: "convex" | "cloudflare", mode: "coordinator" | "cron") {
  await install(provider, "delayed", environmentB);
  if (provider === "convex") await bump(environmentB);
  const repository = repo();
  const claimedAt = Date.now();
  const scope = envScope(appId, environmentB);
  const ready = Promise.withResolvers<void>();
  const response = Promise.withResolvers<void>();
  const sign = crypto.subtle.sign.bind(crypto.subtle);
  const preparing = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    await ready.promise;
    return sign(...args);
  });
  const fetcher = vi.fn(async () => {
    await response.promise;
    return new Response(null, { status: 200, headers: { "splitch-environment-version": "1" } });
  });
  const onDispatch = vi.fn();
  const deps = {
    repo: repository,
    scope,
    fetcher,
    onDispatch,
    leaseOwner: () => "first",
    policy:
      mode === "cron"
        ? cronDeliveryPolicy(provider, () => new Date(claimedAt))
        : coordinatorDeliveryPolicy(),
    webhookKek: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    secretKek: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };
  const run = provider === "convex" ? dispatchConvexWebhooks(deps) : dispatchCloudflarePushes(deps);
  await vi.waitFor(() => expect(preparing).toHaveBeenCalledTimes(1));
  const compete = () =>
    repository[provider].claimDueDeliveries(
      new Date().toISOString(),
      "competitor",
      new Date(Date.now() + 30_000).toISOString(),
      25,
      scope,
    );
  return { repository, claimedAt, ready, response, fetcher, onDispatch, run, compete };
}

it.each(cases)("renews %s %s leases after 27 seconds of preparation", async (provider, mode) => {
  const test = await prepare(provider, mode);
  vi.setSystemTime(test.claimedAt + 27_000);
  test.ready.resolve();
  await vi.waitFor(() => expect(test.fetcher).toHaveBeenCalledTimes(1));
  vi.setSystemTime(test.claimedAt + 31_000);
  const competing = await test.compete();
  // Resolve the request before asserting so a failed guard still drains the first dispatcher.
  vi.setSystemTime(test.claimedAt + 31_800);
  test.response.resolve();
  await expect(test.run).resolves.toBe(1);
  expect(competing).toEqual([]);
});

it.each(cases)("skips %s %s sends after a slow renewal", async (provider, mode) => {
  const test = await prepare(provider, mode);
  const renewed = Promise.withResolvers<void>();
  const renewalResponse = Promise.withResolvers<void>();
  const renew = test.repository[provider].renewDeliveryLease;
  vi.spyOn(test.repository[provider], "renewDeliveryLease").mockImplementation(async (...args) => {
    const result = await renew(...args);
    renewed.resolve();
    await renewalResponse.promise;
    return result;
  });
  vi.setSystemTime(test.claimedAt + 27_000);
  test.ready.resolve();
  await renewed.promise;
  vi.setSystemTime(test.claimedAt + 54_000);
  renewalResponse.resolve();
  await vi.waitFor(() =>
    expect(test.onDispatch.mock.calls.length + test.fetcher.mock.calls.length).toBeGreaterThan(0),
  );
  vi.setSystemTime(test.claimedAt + 58_000);
  const [competing] = await test.compete();
  test.response.resolve();
  await test.run;
  expect(test.fetcher).not.toHaveBeenCalled();
  expect(test.onDispatch).toHaveBeenCalledWith(expect.objectContaining({ skippedLeaseLost: 1 }));
  expect(competing).toMatchObject({ attemptCount: 0 });
});

it.each(cases)("skips %s %s sends after the owned lease expires", async (provider, mode) => {
  const test = await prepare(provider, mode);
  vi.setSystemTime(test.claimedAt + 31_000);
  test.ready.resolve();
  test.response.resolve();
  await test.run;
  expect(test.fetcher).not.toHaveBeenCalled();
  expect(test.onDispatch).toHaveBeenCalledWith(expect.objectContaining({ skippedLeaseLost: 1 }));
  expect(await test.compete()).toHaveLength(1);
});

it.each(cases)("leaves reclaimed %s %s rows with their new owner", async (provider, mode) => {
  const test = await prepare(provider, mode);
  vi.setSystemTime(test.claimedAt + 31_000);
  const [competing] = await test.compete();
  if (!competing) throw new Error("Competitor did not reclaim the expired lease");
  test.ready.resolve();
  test.response.resolve();
  await test.run;
  expect(test.fetcher).not.toHaveBeenCalled();
  expect(test.onDispatch).toHaveBeenCalledWith(expect.objectContaining({ skippedLeaseLost: 1 }));
  await test.repository[provider].finishDelivery(competing.deliveryId, "competitor", {
    state: "delivered",
    now: new Date().toISOString(),
    appliedVersion: 1,
  });
  expect(await test.compete()).toEqual([]);
});
