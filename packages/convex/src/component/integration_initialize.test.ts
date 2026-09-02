import { describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import { initializeHandler } from "./integration_initialize";

const canonical = "https://third-cat-295.convex.site/integrations/splitch/configuration";

describe("initializeHandler", () => {
  it("repairs a pending callback left on a custom domain", async () => {
    const { ctx, patch } = fakeContext([
      integration("https://api.mainstay.club/integrations/splitch/configuration"),
      integration(canonical),
    ]);

    const result = await initializeHandler(ctx, args());

    expect(patch).toHaveBeenCalledWith("integration_id", { callbackUrl: canonical });
    expect(result?.callbackUrl).toBe(canonical);
  });

  it("retains canonical pending installation content for exact retries", async () => {
    const existing = integration(canonical);
    const { ctx, patch } = fakeContext([existing]);

    await expect(initializeHandler(ctx, args())).resolves.toBe(existing);
    expect(patch).not.toHaveBeenCalled();
  });
});

function args() {
  return {
    installationId: "installation_id",
    webhookSecret: "webhook_secret",
    componentIdentityKey: "component_identity_key",
    callbackUrl: canonical,
    endpoint: "https://edge.splitch.dev",
  };
}

function integration(callbackUrl: string) {
  return {
    _id: "integration_id",
    key: "current",
    installationId: "installation_id",
    webhookSecret: "webhook_secret",
    componentIdentityKey: "component_identity_key",
    callbackUrl,
    endpoint: "https://edge.splitch.dev",
    announcedVersion: 0,
    state: "pending",
  } as const;
}

function fakeContext(rows: ReturnType<typeof integration>[]) {
  const unique = vi.fn();
  for (const row of rows) unique.mockResolvedValueOnce(row);
  const patch = vi.fn().mockResolvedValue(undefined);
  return {
    ctx: {
      db: {
        query: vi.fn().mockReturnValue({
          withIndex: vi.fn().mockReturnValue({ unique }),
        }),
        insert: vi.fn(),
        patch,
      },
    } as unknown as MutationCtx,
    patch,
  };
}
