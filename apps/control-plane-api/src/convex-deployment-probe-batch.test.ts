import type { Repository } from "@splitch/db";
import { coordinatorDeliveryPolicy, cronDeliveryPolicy } from "./integration-delivery-limits";
import { afterEach, expect, it, vi } from "vitest";
import { reprobeDormantConvexDeployments } from "./convex-deployments";
import { encryptConvexSecret } from "./convex-secret";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-10-25T08:00:00.000Z");
afterEach(() => vi.useRealTimers());

it.each([
  ["cron", 25],
  ["coordinator", 6],
] as const)(
  "%s finishes all %i callback 404s before running bounded slow probes",
  async (mode, limit) => {
    const encrypted = await encryptConvexSecret("secret", KEY, "v1");
    const deliveries = Array.from({ length: limit }, (_, index) => ({
      deliveryId: `delivery-${index}`,
      installationId: `installation-${index}`,
      callbackUrl: `https://deployment-${index}.convex.site/configuration`,
      secretCiphertext: encrypted.ciphertext,
      secretKeyVersion: "v1",
      environmentVersion: 1,
      bodyJson: "{}",
      attemptCount: 0,
    }));
    const started: number[] = [];
    const completedAtProbe: number[] = [];
    let completed = 0;
    let activeProbes = 0;
    let maxProbes = 0;
    let leaseExpiresAt = 0;
    let firstStarted!: () => void;
    const firstCallback = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const repo = {
      convex: {
        claimDueDeliveries: async (_now: string, _owner: string, expires: string) => {
          leaseExpiresAt = Date.parse(expires);
          return deliveries;
        },
        finishDelivery: vi.fn(async () => {
          completed += 1;
          return crypto.randomUUID();
        }),
        markDeploymentMissing: vi.fn(),
      },
    } as unknown as Repository;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const sending = dispatchConvexWebhooks({
      repo,
      webhookKek: KEY,
      policy: mode === "cron" ? cronDeliveryPolicy("convex") : coordinatorDeliveryPolicy(),
      fetcher: async (url) => {
        if (String(url).endsWith("/configuration")) {
          started.push(Date.now());
          firstStarted();
          await new Promise((resolve) => setTimeout(resolve, 4_900));
          return new Response(null, { status: 404 });
        }
        completedAtProbe.push(completed);
        activeProbes += 1;
        maxProbes = Math.max(maxProbes, activeProbes);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        activeProbes -= 1;
        throw new DOMException("timeout", "TimeoutError");
      },
    });
    await firstCallback;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await sending).toBe(limit);
    expect(started).toHaveLength(limit);
    expect(started.every((time) => time < leaseExpiresAt)).toBe(true);
    expect(completedAtProbe).toEqual(Array(limit).fill(limit));
    expect(maxProbes).toBeLessThanOrEqual(6);
  },
);

it("re-probes 100 dormant installations with at most six concurrent requests", async () => {
  const installations = Array.from({ length: 100 }, (_, index) => ({
    installationId: `installation-${index}`,
    appId: "app",
    environmentId: "env",
    callbackUrl: `https://deployment-${index}.convex.site/configuration`,
  }));
  const dormantDeployments = vi.fn(async () => installations);
  const recordDeploymentCheck = vi.fn(async (_scope, id) => ({
    status: "active",
    deploymentMissingAt: NOW.toISOString(),
    callbackUrl: `https://deployment-${id.replace("installation-", "")}.convex.site/configuration`,
    probeToken: `generation-${id}`,
  }));
  const reactivateDeployment = vi.fn();
  const repo = {
    convex: { dormantDeployments, recordDeploymentCheck, reactivateDeployment },
  } as unknown as Repository;
  let active = 0;
  let maxActive = 0;
  vi.useFakeTimers();
  const probing = reprobeDormantConvexDeployments({
    repo,
    now: NOW,
    fetcher: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      active -= 1;
      return new Response("1.0", { status: 200 });
    },
  });
  await vi.advanceTimersByTimeAsync(85_000);
  await probing;
  expect(dormantDeployments).toHaveBeenCalledExactlyOnceWith(100);
  expect(recordDeploymentCheck).toHaveBeenCalledTimes(100);
  expect(reactivateDeployment).toHaveBeenCalledTimes(100);
  expect(maxActive).toBe(6);
});
