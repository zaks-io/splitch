import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { encryptConvexSecret, signConvexWebhook } from "./convex-secret";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-08-25T12:00:00.000Z");

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
    const healthyBody = '{"deliveryId":"00000000-0000-4000-8000-000000000001"}';
    const poisonedBody = '{"deliveryId":"00000000-0000-4000-8000-000000000002"}';
    const encrypted = await encryptConvexSecret("webhook-secret", KEY, "v1");
    const finishes: Array<{ deliveryId: string; input: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    const repo = {
      convex: {
        claimDueDeliveries: async () => [
          delivery(healthyBody, encrypted.ciphertext),
          delivery(poisonedBody, "not-valid-ciphertext", {
            deliveryId: "00000000-0000-4000-8000-000000000002",
          }),
        ],
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
    expect(finishes).toEqual(
      expect.arrayContaining([
        {
          deliveryId: "00000000-0000-4000-8000-000000000001",
          input: expect.objectContaining({ state: "delivered" }),
        },
        {
          deliveryId: "00000000-0000-4000-8000-000000000002",
          input: expect.objectContaining({
            state: "pending",
            errorJson: expect.stringContaining('"code":"DELIVERY_PREPARATION_FAILED"'),
          }),
        },
      ]),
    );
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
