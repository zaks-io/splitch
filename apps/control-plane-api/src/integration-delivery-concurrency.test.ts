import { envScope, type Repository } from "@splitch/db";
import { expect, it, vi } from "vitest";
import { dispatchCloudflarePushes } from "./cloudflare-push-dispatch";
import { encryptConvexSecret } from "./convex-secret";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";
import { wakeIntegrationDelivery } from "./integration-delivery-access";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

it.each(["convex", "cloudflare"] as const)(
  "bounds %s sends at six and completes a whole claimed batch",
  async (provider) => {
    const secret = await encryptConvexSecret("synthetic-secret", KEY, "v1");
    const deliveries = Array.from({ length: 25 }, (_, index) => ({
      deliveryId: `delivery${index}`,
      installationId: `installation${index}`,
      appId: "app",
      environmentId: "env",
      environmentVersion: 1,
      bodyJson: "{}",
      attemptCount: 0,
      callbackUrl: "https://receiver.convex.site/configuration",
      endpoint: "https://receiver.workers.dev/integrations/splitch/configuration",
      secretCiphertext: secret.ciphertext,
      secretKeyVersion: "v1",
      lastAppliedVersion: 1,
      registeredAt: "2026-01-01T00:00:00.000Z",
    }));
    const finishDelivery = vi.fn(async () => {});
    const repo = {
      [provider]: {
        claimDueDeliveries: async () => deliveries,
        finishDelivery,
        environmentVersion: async () => 1,
      },
      flags: { flags: { findMany: async () => [] } },
    } as unknown as Repository;
    let active = 0;
    let peak = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response(null, { status: 200, headers: { "splitch-environment-version": "1" } });
    });
    const deps = { repo, scope: envScope("app", "env"), fetcher, webhookKek: KEY, secretKek: KEY };
    await (provider === "convex" ? dispatchConvexWebhooks(deps) : dispatchCloudflarePushes(deps));
    expect(peak).toBe(6);
    expect(fetcher).toHaveBeenCalledTimes(25);
    expect(finishDelivery).toHaveBeenCalledTimes(25);
  },
);

it("attempts every wake at bounded concurrency even when one Environment fails", async () => {
  let active = 0;
  let peak = 0;
  const names: string[] = [];
  const env = {
    INTEGRATION_DELIVERY: {
      getByName(name: string) {
        return {
          async wake() {
            names.push(name);
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            if (name === "app:env0") throw new Error("wake failed");
          },
        };
      },
    },
  };
  await expect(
    wakeIntegrationDelivery(
      env,
      Array.from({ length: 20 }, (_, i) => envScope("app", `env${i}`)),
    ),
  ).rejects.toThrow("wakes failed");
  expect(names).toHaveLength(20);
  expect(peak).toBe(6);
});
