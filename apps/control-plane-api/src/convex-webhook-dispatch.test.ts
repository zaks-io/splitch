import { ConvexInstallationStatusSchema } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { encryptConvexSecret, signConvexWebhook } from "./convex-secret";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-08-25T12:00:00.000Z");

describe("Convex preparation isolation", () => {
  it.each([undefined, "invalid", "AA=="])(
    "rejects missing or invalid KEK before leasing: %s",
    async (webhookKek) => {
      const claimDueDeliveries = vi.fn();
      const repo = { convex: { claimDueDeliveries } } as unknown as Repository;
      await expect(dispatchConvexWebhooks({ repo, webhookKek })).rejects.toThrow();
      expect(claimDueDeliveries).not.toHaveBeenCalled();
    },
  );
  it("reports failed deferral after healthy deliveries complete and deduplicates installation preparation", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const encrypted = await encryptConvexSecret("webhook-secret", KEY, "v1");
    const deferPreparationFailure = vi.fn(async () => {
      throw new Error("deferral failed");
    });
    const finishDelivery = vi.fn();
    const repo = {
      convex: {
        claimDueDeliveries: async () => [
          delivery("{}", "broken", { installationId: "broken", deliveryId: "broken-1" }),
          delivery("{}", "broken", { installationId: "broken", deliveryId: "broken-2" }),
          delivery("{}", encrypted.ciphertext),
        ],
        deferPreparationFailure,
        finishDelivery,
      },
    } as unknown as Repository;
    const onDispatch = vi.fn();
    await expect(
      dispatchConvexWebhooks({
        repo,
        webhookKek: KEY,
        now: () => NOW,
        fetcher: async () => new Response(null, { status: 202 }),
        onDispatch,
      }),
    ).rejects.toThrow("2 Convex delivery lease updates failed");
    expect(deferPreparationFailure).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(finishDelivery).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ state: "delivered" }),
    );
    expect(onDispatch).toHaveBeenCalledWith({
      claimed: 3,
      received2xx: 1,
      receiverRejected: 0,
      transportFailures: 0,
      preparationFailedInstallations: 1,
    });
    consoleError.mockRestore();
  });
});

describe("Convex config webhook dispatch", () => {
  it("signs the exact stored body and marks a 2xx delivery complete", async () => {
    const bodyJson = '{"deliveryId":"00000000-0000-4000-8000-000000000001"}';
    const { repo, finishes } = await fixture(bodyJson);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const timestamp = Math.floor(NOW.getTime() / 1_000).toString();
      expect(init?.body).toBe(bodyJson);
      expect(headers.get("splitch-timestamp")).toBe(timestamp);
      expect(headers.get("splitch-signature")).toBe(
        `v1=${await signConvexWebhook("webhook-secret", timestamp, bodyJson)}`,
      );
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 202 });
    });

    await expect(
      dispatchConvexWebhooks({ repo, webhookKek: KEY, fetcher, now: () => NOW }),
    ).resolves.toBe(1);
    expect(finishes).toEqual([
      expect.objectContaining({ state: "delivered", now: NOW.toISOString() }),
    ]);
  });

  it("retries 5xx and makes deterministic 4xx terminal", async () => {
    for (const [status, state] of [
      [503, "pending"],
      [400, "terminal"],
    ] as const) {
      const { repo, finishes } = await fixture("{}");
      await dispatchConvexWebhooks({
        repo,
        webhookKek: KEY,
        fetcher: async () => new Response(null, { status }),
        now: () => NOW,
      });
      expect(finishes[0]).toMatchObject({ state });
    }
  });

  it("isolates an undecryptable delivery without disconnecting healthy siblings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const healthyBody = '{"deliveryId":"00000000-0000-4000-8000-000000000001"}';
    const poisonedBody = '{"deliveryId":"00000000-0000-4000-8000-000000000002"}';
    const encrypted = await encryptConvexSecret("webhook-secret", KEY, "v1");
    const finishes: Array<{ deliveryId: string; input: Record<string, unknown> }> = [];
    const deferrals: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    const repo = {
      convex: {
        claimDueDeliveries: async () => [
          delivery(healthyBody, encrypted.ciphertext),
          delivery(poisonedBody, "not-valid-ciphertext", {
            deliveryId: "00000000-0000-4000-8000-000000000002",
            installationId: "poisoned-installation",
          }),
        ],
        deferPreparationFailure: async (
          _id: string,
          _owner: string,
          input: Record<string, unknown>,
        ) => {
          deferrals.push(input);
        },
        finishDelivery: async (
          deliveryId: string,
          _leaseOwner: string,
          input: Record<string, unknown>,
        ) => finishes.push({ deliveryId, input }),
      },
    } as unknown as Repository;

    await expect(
      dispatchConvexWebhooks({ repo, webhookKek: KEY, fetcher, now: () => NOW }),
    ).resolves.toBe(2);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith("convex_webhook_delivery_preparation_failed", {
      installationId: "poisoned-installation",
      deliveryId: "00000000-0000-4000-8000-000000000002",
      code: "DELIVERY_PREPARATION_FAILED",
      causeName: "Error",
    });
    consoleError.mockRestore();
    expect(deferrals).toEqual([
      expect.objectContaining({
        retryAt: "2026-08-25T12:30:00.000Z",
        errorJson: expect.stringContaining("DELIVERY_PREPARATION_FAILED"),
      }),
    ]);
    expect(finishes).toEqual(
      expect.arrayContaining([
        {
          deliveryId: "00000000-0000-4000-8000-000000000001",
          input: expect.objectContaining({ state: "delivered" }),
        },
      ]),
    );
  });

  it("reports a lease update failure after healthy siblings finish", async () => {
    const firstBody = '{"deliveryId":"00000000-0000-4000-8000-000000000001"}';
    const secondBody = '{"deliveryId":"00000000-0000-4000-8000-000000000002"}';
    const encrypted = await encryptConvexSecret("webhook-secret", KEY, "v1");
    const finishAttempts: string[] = [];
    const repo = {
      convex: {
        claimDueDeliveries: async () => [
          delivery(firstBody, encrypted.ciphertext),
          delivery(secondBody, encrypted.ciphertext, {
            deliveryId: "00000000-0000-4000-8000-000000000002",
            installationId: "poisoned-installation",
          }),
        ],
        finishDelivery: async (deliveryId: string) => {
          finishAttempts.push(deliveryId);
          if (deliveryId === "00000000-0000-4000-8000-000000000001")
            throw new Error("D1 completion failed");
        },
      },
    } as unknown as Repository;

    await expect(
      dispatchConvexWebhooks({
        repo,
        webhookKek: KEY,
        fetcher: async () => new Response(null, { status: 202 }),
        now: () => NOW,
      }),
    ).rejects.toThrow("1 Convex delivery lease updates failed");

    expect(finishAttempts).toHaveLength(2);
    expect(finishAttempts).toEqual(
      expect.arrayContaining([
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ]),
    );
  });
});

describe("Convex preparation diagnostics", () => {
  it("records the exception type for an unreadable secret without logging secret material", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { repo, finishes } = await fixture("{}");
    const differentKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));

    await dispatchConvexWebhooks({ repo, webhookKek: differentKey, fetcher, now: () => NOW });

    expect(fetcher).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("convex_webhook_delivery_preparation_failed", {
      installationId: "00000000-0000-4000-8000-000000000002",
      deliveryId: "00000000-0000-4000-8000-000000000001",
      code: "DELIVERY_PREPARATION_FAILED",
      causeName: "OperationError",
    });
    expect(finishes[0]).toMatchObject({
      retryAt: "2026-08-25T12:30:00.000Z",
      errorJson: JSON.stringify({
        kind: "internal",
        code: "DELIVERY_PREPARATION_FAILED",
        occurredAt: NOW.toISOString(),
      }),
    });
    expect(
      ConvexInstallationStatusSchema.shape.latestDeliveryError.parse(
        JSON.parse(finishes[0]?.errorJson as string),
      ),
    ).toEqual({
      kind: "internal",
      code: "DELIVERY_PREPARATION_FAILED",
      occurredAt: NOW.toISOString(),
    });
    consoleError.mockRestore();
  });
});

function delivery(
  bodyJson: string,
  secretCiphertext: string,
  overrides: Partial<{
    deliveryId: string;
    installationId: string;
    callbackUrl: string;
  }> = {},
) {
  return {
    deliveryId: "00000000-0000-4000-8000-000000000001",
    installationId: "00000000-0000-4000-8000-000000000002",
    callbackUrl: "https://example.convex.site/integrations/splitch/configuration",
    secretCiphertext,
    secretKeyVersion: "v1",
    environmentVersion: 2,
    bodyJson,
    attemptCount: 0,
    ...overrides,
  };
}

async function fixture(bodyJson: string) {
  const encrypted = await encryptConvexSecret("webhook-secret", KEY, "v1");
  const finishes: Array<Record<string, unknown>> = [];
  const convex = {
    deferPreparationFailure: async (
      _id: string,
      _owner: string,
      input: Record<string, unknown>,
    ) => {
      finishes.push(input);
    },
    claimDueDeliveries: async () => [delivery(bodyJson, encrypted.ciphertext)],
    finishDelivery: async (
      _deliveryId: string,
      _leaseOwner: string,
      input: Record<string, unknown>,
    ) => {
      finishes.push(input);
    },
  };
  return { repo: { convex } as unknown as Repository, finishes };
}
