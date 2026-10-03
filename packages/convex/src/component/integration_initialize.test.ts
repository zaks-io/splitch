import { describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import { initializeHandler, installCallbackUrl } from "./integration_initialize";

const canonical = "https://third-cat-295.convex.site/integrations/splitch/configuration";
const customDomain = "https://hooks.mainstay.club/integrations/splitch/configuration";

describe("installCallbackUrl", () => {
  it.each(["active", "revoked", "pending"] as const)(
    "reuses a canonical callback from a %s installation",
    (state) => {
      const derive = vi.fn(() => "https://other.convex.site/configuration");
      expect(installCallbackUrl({ ...integration(canonical), state } as never, derive)).toBe(
        canonical,
      );
      expect(derive).not.toHaveBeenCalled();
    },
  );

  it.each([null, { ...integration(customDomain), state: "pending" }])(
    "derives a callback for a missing or pending custom-domain installation",
    (existing) => {
      const derive = vi.fn(() => canonical);
      expect(installCallbackUrl(existing as never, derive)).toBe(canonical);
      expect(derive).toHaveBeenCalledOnce();
    },
  );

  it.each([null, { ...integration(customDomain), state: "pending" }])(
    "propagates derivation failure for a missing or pending custom-domain installation",
    (existing) => {
      const derive = vi.fn((): string => {
        throw new Error("CONVEX_CLOUD_URL cannot identify a canonical callback");
      });
      expect(() => installCallbackUrl(existing as never, derive)).toThrow("CONVEX_CLOUD_URL");
      expect(derive).toHaveBeenCalledOnce();
    },
  );
});

describe("initializeHandler", () => {
  it("repairs a pending callback left on a custom domain", async () => {
    const { ctx, patch } = fakeContext(integration(customDomain));

    const result = await initializeHandler(ctx, args());

    expect(patch).toHaveBeenCalledWith("integration_id", { callbackUrl: canonical });
    expect(result?.callbackUrl).toBe(canonical);
  });

  it("retains canonical pending installation content for exact retries", async () => {
    const existing = integration(canonical);
    const { ctx, patch } = fakeContext(existing);

    await expect(initializeHandler(ctx, args())).resolves.toBe(existing);
    expect(patch).not.toHaveBeenCalled();
  });

  it("inserts the canonical callback when no installation exists", async () => {
    const { ctx, patch } = fakeContext(null);

    const result = await initializeHandler(ctx, args());

    expect(result).toMatchObject({ key: "current", callbackUrl: canonical, state: "pending" });
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

type IntegrationRow = Record<string, unknown> & { _id: string; callbackUrl: string };

function integration(callbackUrl: string): IntegrationRow {
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
  };
}

// One mutable row that `patch` and `insert` actually write, so a read after the
// handler reflects what the handler did rather than a queued mock value.
function fakeContext(initial: IntegrationRow | null) {
  let row = initial;
  const patch = vi.fn(async (id: string, fields: Record<string, unknown>) => {
    if (!row || row._id !== id) throw new Error(`patched a row that does not exist: ${id}`);
    row = { ...row, ...fields } as IntegrationRow;
  });
  const insert = vi.fn(async (_table: string, doc: Record<string, unknown>) => {
    row = { _id: "integration_id", ...doc } as IntegrationRow;
  });
  return {
    ctx: {
      db: {
        query: vi.fn().mockReturnValue({
          withIndex: vi.fn().mockReturnValue({ unique: async () => row }),
        }),
        insert,
        patch,
      },
    } as unknown as MutationCtx,
    patch,
    insert,
  };
}
