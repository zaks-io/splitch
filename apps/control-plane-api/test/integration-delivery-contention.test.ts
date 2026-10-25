import { envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatchCloudflarePushes } from "../src/cloudflare-push-dispatch";
import { dispatchConvexWebhooks } from "../src/convex-webhook-dispatch";
import { coordinatorDeliveryPolicy } from "../src/integration-delivery-limits";
import { runIntegrationDelivery } from "../src/integration-delivery-run";
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

it.each(["convex", "cloudflare"] as const)(
  "does not reclaim an in-flight %s send with slow D1 completion",
  async (provider) => {
    for (let i = 0; i < 25; i++) await install(provider, `slow${i}`, environmentB);
    if (provider === "convex") await bump(environmentB);
    const repository = repo();
    const scope = envScope(appId, environmentB);
    const startedAt = Date.now();
    const sends: Array<() => void> = [];
    const completions: Array<() => void> = [];
    const finish = repository[provider].finishDelivery;
    vi.spyOn(repository[provider], "finishDelivery").mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => completions.push(resolve));
      await finish(...args);
    });
    const fetcher = vi.fn(async () => {
      await new Promise<void>((resolve) => sends.push(resolve));
      return new Response(null, { status: 200, headers: { "splitch-environment-version": "1" } });
    });
    const deps = {
      repo: repository,
      scope,
      fetcher,
      policy: coordinatorDeliveryPolicy(),
      webhookKek: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      secretKek: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };
    const dispatch = () =>
      provider === "convex" ? dispatchConvexWebhooks(deps) : dispatchCloudflarePushes(deps);
    const run = runIntegrationDelivery({
      repo: repository,
      scope,
      subrequests: { count: 0 },
      now: () => new Date(),
      dispatchConvex: provider === "convex" ? dispatch : async () => 0,
      dispatchCloudflare: provider === "cloudflare" ? dispatch : async () => 0,
    });
    // Four waves cost 4.8 seconds of HTTP plus 2 seconds of D1 completion each.
    for (let wave = 0; wave < 4; wave++) {
      const sent = (wave + 1) * 6;
      await vi.waitFor(() => expect(sends).toHaveLength(sent));
      vi.setSystemTime(startedAt + wave * 6800 + 4800);
      for (const resolve of sends.slice(wave * 6, sent)) resolve();
      await vi.waitFor(() => expect(completions).toHaveLength(sent));
      vi.setSystemTime(startedAt + (wave + 1) * 6800);
      for (const resolve of completions.slice(wave * 6, sent)) resolve();
    }
    await vi.waitFor(() => expect(sends).toHaveLength(25));
    vi.setSystemTime(startedAt + 31_000);
    const competing = await repository[provider].claimDueDeliveries(
      new Date().toISOString(),
      "competitor",
      new Date(Date.now() + 30_000).toISOString(),
      25,
      scope,
    );
    expect(competing).toEqual([]);
    sends[24]?.();
    await vi.waitFor(() => expect(completions).toHaveLength(25));
    vi.setSystemTime(startedAt + 34_000);
    completions[24]?.();
    await run;
    expect(fetcher).toHaveBeenCalledTimes(25);
  },
);
