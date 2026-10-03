import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { install } from "./integration";
import { initializeHandler } from "./integration_initialize";

const callbackUrl = "https://dashing-rook-238.convex.site/integrations/splitch/configuration";
const installationId = "f35d40f3-e178-4e5c-a45b-251790247fd1";
const existing = {
  _id: "integration_id",
  key: "current",
  installationId,
  webhookSecret: "stored_secret",
  componentIdentityKey: "stored_identity",
  callbackUrl,
  endpoint: "https://edge.splitch.dev",
  appId: "app_1",
  environmentId: "env_1",
  announcedVersion: 165,
  snapshotVersion: 165,
  state: "active",
};
const installed = {
  installationId,
  appId: "app_1",
  environmentId: "env_1",
  environmentVersion: 165,
  status: "active",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("install", () => {
  it.each([
    ["both custom URLs", "https://api.chat.zaks.io", "https://gateway.chat.zaks.io"],
    ["missing automatic URLs", undefined, undefined],
  ])("reuses the stored canonical callback with %s", async (_label, cloudUrl, siteUrl) => {
    vi.stubEnv("CONVEX_CLOUD_URL", cloudUrl);
    vi.stubEnv("CONVEX_SITE_URL", siteUrl);
    vi.stubEnv("SPLITCH_API_KEY", "test_key");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(installed))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetch);
    const runMutation = vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(null);
    const runQuery = vi.fn().mockResolvedValue(existing);

    await expect(
      install._handler({ runMutation, runQuery } as unknown as ActionCtx, {}),
    ).resolves.toEqual(installed);

    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(runMutation.mock.calls[0]?.[1]).toMatchObject({ callbackUrl });
    expect(fetch).toHaveBeenCalledTimes(2);
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      installationId,
      callbackUrl,
      webhookSecret: existing.webhookSecret,
    });
  });

  it("refuses to repair a pending noncanonical callback with a custom cloud URL", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://api.chat.zaks.io");
    vi.stubEnv("CONVEX_SITE_URL", "https://gateway.chat.zaks.io/integrations/splitch");
    vi.stubEnv("SPLITCH_API_KEY", "test_key");
    const runMutation = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      install._handler(
        {
          runMutation,
          runQuery: vi.fn().mockResolvedValue({
            ...existing,
            state: "pending",
            callbackUrl: "https://gateway.chat.zaks.io/integrations/splitch/configuration",
          }),
        } as unknown as ActionCtx,
        {},
      ),
    ).rejects.toThrow("CONVEX_CLOUD_URL");

    expect(runMutation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("repairs a pending noncanonical callback before registration", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://dashing-rook-238.convex.cloud");
    vi.stubEnv("CONVEX_SITE_URL", "https://gateway.chat.zaks.io/integrations/splitch");
    vi.stubEnv("SPLITCH_API_KEY", "test_key");
    const pending = {
      ...existing,
      state: "pending",
      callbackUrl: "https://gateway.chat.zaks.io/integrations/splitch/configuration",
    };
    const patch = vi.fn(async (_id: string, fields: Record<string, unknown>) => {
      Object.assign(pending, fields);
    });
    const mutationCtx = {
      db: {
        query: () => ({ withIndex: () => ({ unique: async () => pending }) }),
        patch,
      },
    } as unknown as MutationCtx;
    const runMutation = vi
      .fn()
      .mockImplementationOnce((_reference, args) => initializeHandler(mutationCtx, args))
      .mockResolvedValueOnce(null);
    const runQuery = vi.fn().mockImplementation(async () => pending);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(installed))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      install._handler({ runMutation, runQuery } as unknown as ActionCtx, {}),
    ).resolves.toEqual(installed);

    expect(patch).toHaveBeenCalledWith(existing._id, { callbackUrl });
    expect(pending.callbackUrl).toBe(callbackUrl);
    expect(runMutation.mock.calls[0]?.[1]).toMatchObject({ callbackUrl });
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string).callbackUrl).toBe(callbackUrl);
  });

  it("refuses a fresh install with two custom domains before initialization", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://api.chat.zaks.io");
    vi.stubEnv("CONVEX_SITE_URL", "https://gateway.chat.zaks.io");
    vi.stubEnv("SPLITCH_API_KEY", "test_key");
    const runMutation = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      install._handler(
        { runMutation, runQuery: vi.fn().mockResolvedValue(null) } as unknown as ActionCtx,
        {},
      ),
    ).rejects.toThrow("CONVEX_CLOUD_URL");

    expect(runMutation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
