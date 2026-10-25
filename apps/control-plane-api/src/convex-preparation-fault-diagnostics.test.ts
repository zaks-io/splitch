import { cronDeliveryPolicy } from "./integration-delivery-limits";
import { inspect } from "node:util";
import type { Repository } from "@splitch/db";
import { afterEach, expect, it, vi } from "vitest";
import { encryptConvexSecret } from "./convex-secret";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";

afterEach(() => vi.restoreAllMocks());

it("withholds native parse causes at the Convex secret preparation boundary", async () => {
  const canary = "qxZ7s3crt";
  let failure: unknown;
  try {
    JSON.parse(`${canary}!`);
  } catch (error) {
    failure = error;
  }
  expect((failure as Error).message).toContain(canary);
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const encrypted = await encryptConvexSecret("webhook-secret", key, "v1");
  vi.spyOn(crypto.subtle, "decrypt").mockRejectedValueOnce(
    new Error("decryption failed", { cause: failure }),
  );
  const logs = ["error", "warn", "info", "log"].map((method) =>
    vi.spyOn(console, method as "error").mockImplementation(() => {}),
  );
  const defer = vi.fn();
  const fetcher = vi.fn();
  const repo = {
    convex: {
      claimDueDeliveries: async () => [
        {
          deliveryId: "delivery_1",
          installationId: "installation_1",
          callbackUrl: "https://example.convex.site/webhook",
          secretCiphertext: encrypted.ciphertext,
          secretKeyVersion: "v1",
          environmentVersion: 2,
          bodyJson: "{}",
          attemptCount: 0,
        },
      ],
      deferPreparationFailure: defer,
    },
  } as unknown as Repository;

  await dispatchConvexWebhooks({
    repo,
    webhookKek: key,
    fetcher,
    policy: cronDeliveryPolicy("convex"),
  });

  expect(fetcher).not.toHaveBeenCalled();
  expect(defer).toHaveBeenCalledOnce();
  expect(logs[0]).toHaveBeenCalledWith(
    "convex_webhook_delivery_preparation_failed",
    expect.any(Object),
  );
  const logged = inspect(
    logs.map((log) => log.mock.calls),
    {
      showHidden: true,
      depth: null,
      maxStringLength: null,
      maxArrayLength: null,
    },
  );
  expect(logged).not.toContain(canary);
  expect(logged).toContain("[message withheld]");
});
