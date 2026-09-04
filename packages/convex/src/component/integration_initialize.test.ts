import { describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import { initializeHandler } from "./integration_initialize";

const canonical = "https://third-cat-295.convex.site/integrations/splitch/configuration";
const customDomain = "https://hooks.mainstay.club/integrations/splitch/configuration";

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
