import type { FlagsClient } from "@splitch/control-plane-sdk";
import { describe, expect, it, vi } from "vitest";
import { createFlagConfigApi } from "./flag-config-api";

const scope = { appId: "app_checkout", environmentId: "env_prod" };

function stubFlags() {
  return {
    getConfig: vi.fn(async () => ({ ok: true as const, data: {} })),
    updateConfig: vi.fn(async () => ({ ok: true as const, data: {} })),
  } as unknown as Pick<FlagsClient, "getConfig" | "updateConfig"> & {
    updateConfig: ReturnType<typeof vi.fn>;
  };
}

describe("Control Panel Flag Configuration adapter", () => {
  it("never injects a Review, so a Policy-gated change cannot self-approve", async () => {
    // The panel has no Review UI. Defaulting `review` to `approve_and_apply`
    // here turned every Environment Policy gate into a no-op on this surface:
    // the proposer's own request was approved and applied in the same call.
    const flags = stubFlags();
    await createFlagConfigApi(flags).update(scope, "flag_checkout", {
      enabled: true,
      idempotency_key: "idem_panel_1",
    });

    const [payload] = flags.updateConfig.mock.calls[0] as [Record<string, unknown>];
    expect(payload).not.toHaveProperty("review");
    expect(payload).toMatchObject({
      ...scope,
      flagId: "flag_checkout",
      enabled: true,
      // The caller's key has to survive the adapter untouched: re-minting or
      // dropping it turns a retried Configuration change into a second write.
      idempotency_key: "idem_panel_1",
    });
  });

  it("forwards an explicit Review untouched", async () => {
    const flags = stubFlags();
    const review = { action: "approve_and_apply" as const };
    await createFlagConfigApi(flags).update(scope, "flag_checkout", {
      enabled: true,
      idempotency_key: "idem_panel_2",
      review,
    });

    const [payload] = flags.updateConfig.mock.calls[0] as [Record<string, unknown>];
    expect(payload.review).toBe(review);
  });
});
