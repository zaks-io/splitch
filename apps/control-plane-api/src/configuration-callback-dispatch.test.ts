import { ConvexInstallationStatusSchema } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { encryptConvexSecret } from "./convex-secret";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-08-25T12:00:00.000Z");

describe("stored configuration callback destinations", () => {
  it.each(["https://127.0.0.1/configuration", "https://api.splitch.dev/configuration"])(
    "terminates an unsafe stored callback without preventing healthy delivery: %s",
    async (callbackUrl) => {
      const encrypted = await encryptConvexSecret("webhook-secret", KEY, "v1");
      const finishDelivery = vi.fn();
      const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
      const repo = {
        convex: {
          claimDueDeliveries: async () => [
            ...[callbackUrl, "https://example.convex.site/integrations/splitch/configuration"].map(
              (url, index) => ({
                deliveryId: index === 0 ? "unsafe" : "healthy",
                installationId: `installation_${index}`,
                callbackUrl: url,
                secretCiphertext: encrypted.ciphertext,
                secretKeyVersion: "v1",
                environmentVersion: 2,
                bodyJson: "{}",
                attemptCount: 0,
              }),
            ),
          ],
          finishDelivery,
        },
      } as unknown as Repository;
      await dispatchConvexWebhooks({ repo, webhookKek: KEY, fetcher, now: () => NOW });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledWith(
        "https://example.convex.site/integrations/splitch/configuration",
        expect.any(Object),
      );
      const error = {
        kind: "internal",
        code: "CALLBACK_DESTINATION_REJECTED",
        occurredAt: NOW.toISOString(),
      };
      expect(finishDelivery).toHaveBeenCalledWith("unsafe", expect.any(String), {
        state: "terminal",
        now: NOW.toISOString(),
        errorJson: JSON.stringify(error),
      });
      expect(ConvexInstallationStatusSchema.shape.latestDeliveryError.parse(error)).toEqual(error);
      expect(finishDelivery).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
        state: "delivered",
        now: NOW.toISOString(),
      });
    },
  );
});
