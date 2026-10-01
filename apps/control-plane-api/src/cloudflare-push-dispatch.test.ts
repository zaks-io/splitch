import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { dispatchCloudflarePushes } from "./cloudflare-push-dispatch";
import { encryptIntegrationSecret, signIntegrationPayload } from "./integration-secret";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-08-25T12:00:00.000Z");
const DELIVERY_ID = "00000000-0000-4000-8000-000000000001";

describe("Cloudflare configuration push dispatch", () => {
  it("builds and signs the exact snapshot body before recording the applied version", async () => {
    const { repo, finishes } = await fixture();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body);
      const headers = new Headers(init?.headers);
      const timestamp = Math.floor(NOW.getTime() / 1_000).toString();
      expect(JSON.parse(body)).toEqual({
        schemaVersion: 1,
        environmentVersion: 2,
        appId: "app_1",
        environmentId: "env_1",
        flags: [],
        experiments: [],
        runs: [],
      });
      expect(headers.get("splitch-delivery-id")).toBe(DELIVERY_ID);
      expect(headers.get("splitch-timestamp")).toBe(timestamp);
      expect(headers.get("splitch-signature")).toBe(
        `v1=${await signIntegrationPayload("push-secret", `${timestamp}.${DELIVERY_ID}.${body}`)}`,
      );
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 204,
        headers: { "splitch-environment-version": "2" },
      });
    });

    await expect(
      dispatchCloudflarePushes({ repo, secretKek: KEY, fetcher, now: () => NOW }),
    ).resolves.toBe(1);
    expect(finishes).toEqual([
      expect.objectContaining({ state: "delivered", appliedVersion: 2, now: NOW.toISOString() }),
    ]);
  });

  it("retries a success response that does not prove the target version was applied", async () => {
    const { repo, finishes } = await fixture();
    await dispatchCloudflarePushes({
      repo,
      secretKek: KEY,
      fetcher: async () => new Response(null, { status: 204 }),
      now: () => NOW,
    });
    expect(finishes[0]).toMatchObject({ state: "pending" });
    expect(JSON.parse(String(finishes[0]?.errorJson))).toMatchObject({
      kind: "protocol",
      code: "VERSION_NOT_CONFIRMED",
    });
  });

  it("records the transport error name", async () => {
    const { repo, finishes } = await fixture();
    await dispatchCloudflarePushes({
      repo,
      secretKek: KEY,
      fetcher: async () => {
        throw new TypeError("connection failed");
      },
      now: () => NOW,
    });
    expect(JSON.parse(String(finishes[0]?.errorJson))).toMatchObject({
      kind: "transport",
      code: "TypeError",
    });
  });

  it("isolates preparation failures and reuses one snapshot per Environment", async () => {
    const { repo, finishes, deliveries, environmentVersion } = await fixture();
    const second = {
      ...deliveries[0],
      deliveryId: "00000000-0000-4000-8000-000000000003",
    };
    deliveries.unshift({ ...deliveries[0], secretCiphertext: "invalid" });
    deliveries[1] = second;
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 204,
          headers: { "splitch-environment-version": "2" },
        }),
    );

    await expect(
      dispatchCloudflarePushes({ repo, secretKek: KEY, fetcher, now: () => NOW }),
    ).resolves.toBe(2);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(environmentVersion).toHaveBeenCalledTimes(2);
    expect(finishes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deliveryId: DELIVERY_ID,
          state: "pending",
          errorJson: expect.stringContaining("DELIVERY_PREPARATION_FAILED"),
        }),
        expect.objectContaining({ deliveryId: second.deliveryId, state: "delivered" }),
      ]),
    );
  });

  it("retries 5xx and makes deterministic 4xx terminal", async () => {
    for (const [status, state] of [
      [503, "pending"],
      [400, "terminal"],
    ] as const) {
      const { repo, finishes } = await fixture();
      await dispatchCloudflarePushes({
        repo,
        secretKek: KEY,
        fetcher: async () => new Response(null, { status }),
        now: () => NOW,
      });
      expect(finishes[0]).toMatchObject({ state });
    }
  });
});

describe("Cloudflare first setup push window", () => {
  it("reads a 404 as route propagation only before the first apply and within the window", async () => {
    for (const [lastAppliedVersion, registeredAt, state] of [
      [null, "2026-08-25T11:59:00.000Z", "pending"],
      [null, "2026-08-25T11:50:00.001Z", "pending"],
      [null, "2026-08-25T11:50:00.000Z", "terminal"],
      [1, "2026-08-25T11:59:00.000Z", "terminal"],
    ] as const) {
      const { repo, finishes, deliveries } = await fixture();
      // A high attempt count would have exhausted the old count-based allowance.
      Object.assign(deliveries[0] ?? {}, { lastAppliedVersion, registeredAt, attemptCount: 5 });
      await dispatchCloudflarePushes({
        repo,
        secretKek: KEY,
        fetcher: async () => new Response(null, { status: 404 }),
        now: () => NOW,
      });
      expect(finishes[0]).toMatchObject({ state });
      expect(JSON.parse(String(finishes[0]?.errorJson))).toMatchObject({ httpStatus: 404 });
    }
  });

  it("retries first setup on the next dispatcher tick instead of climbing the backoff ladder", async () => {
    for (const [status, lastAppliedVersion, registeredAt, nextAttemptAt] of [
      [404, null, "2026-08-25T11:59:00.000Z", "2026-08-25T12:00:30.000Z"],
      [503, null, "2026-08-25T11:59:00.000Z", "2026-08-25T12:00:30.000Z"],
      [503, null, "2026-08-25T11:50:00.000Z", "2026-08-25T12:30:00.000Z"],
      [503, 1, "2026-08-25T11:59:00.000Z", "2026-08-25T12:30:00.000Z"],
    ] as const) {
      const { repo, finishes, deliveries } = await fixture();
      Object.assign(deliveries[0] ?? {}, { lastAppliedVersion, registeredAt, attemptCount: 6 });
      await dispatchCloudflarePushes({
        repo,
        secretKek: KEY,
        fetcher: async () => new Response(null, { status }),
        now: () => NOW,
      });
      expect(finishes[0]).toMatchObject({ state: "pending", nextAttemptAt });
    }
  });

  it("fails the run without pushing when the registration time is not a timestamp", async () => {
    const { repo, finishes, deliveries } = await fixture();
    Object.assign(deliveries[0] ?? {}, { registeredAt: "not-a-time" });
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(
      dispatchCloudflarePushes({ repo, secretKek: KEY, fetcher, now: () => NOW }),
    ).rejects.toThrow("1 Cloudflare delivery lease updates failed");
    expect(fetcher).not.toHaveBeenCalled();
    expect(finishes).toEqual([]);
  });
});

async function fixture() {
  const encrypted = await encryptIntegrationSecret("push-secret", KEY, "v1", "test key");
  const finishes: Array<Record<string, unknown>> = [];
  const deliveries = [
    {
      deliveryId: DELIVERY_ID,
      installationId: "00000000-0000-4000-8000-000000000002",
      appId: "app_1",
      environmentId: "env_1",
      endpoint: "https://splitch-config.customer.workers.dev/integrations/splitch/configuration",
      secretCiphertext: encrypted.ciphertext,
      secretKeyVersion: encrypted.keyVersion,
      environmentVersion: 2,
      attemptCount: 0,
      lastAppliedVersion: null as number | null,
      registeredAt: "2026-08-25T11:59:00.000Z",
    },
  ];
  const environmentVersion = vi.fn(async () => 2);
  const cloudflare = {
    claimDueDeliveries: async () => deliveries,
    environmentVersion,
    finishDelivery: async (
      _deliveryId: string,
      _leaseOwner: string,
      input: Record<string, unknown>,
    ) => {
      finishes.push({ deliveryId: _deliveryId, ...input });
    },
  };
  const repo = {
    cloudflare,
    flags: { flags: { findMany: async () => [] } },
  } as unknown as Repository;
  return { repo, finishes, deliveries, environmentVersion };
}
