import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { install } from "./integration";
import { initializeHandler } from "./integration_initialize";

const callbackUrl = "https://dashing-rook-238.convex.site/integrations/splitch/configuration";
const customCallbackUrl = "https://gateway.chat.zaks.io/integrations/splitch/configuration";
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
    ["active", callbackUrl],
    ["revoked", callbackUrl],
    ["pending", callbackUrl],
    ["active", customCallbackUrl],
    ["revoked", customCallbackUrl],
    ["pending", customCallbackUrl],
  ])("reuses a stored %s callback %s without automatic URLs", async (state, storedCallbackUrl) => {
    vi.stubEnv("CONVEX_CLOUD_URL", undefined);
    vi.stubEnv("CONVEX_SITE_URL", undefined);
    const setup = installContext({ ...existing, state, callbackUrl: storedCallbackUrl });

    await expect(install._handler(setup.ctx, {})).resolves.toEqual(installed);

    expect(setup.patch).not.toHaveBeenCalled();
    expect(registrationBody(setup.fetch)).toEqual({
      installationId,
      callbackUrl: storedCallbackUrl,
      webhookSecret: existing.webhookSecret,
      callbackVerification: "hmac-sha256",
    });
  });

  it("repairs an invalid pending callback using the current custom HTTP Actions URL", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", undefined);
    vi.stubEnv("CONVEX_SITE_URL", "https://gateway.chat.zaks.io/integrations/splitch");
    const setup = installContext({
      ...existing,
      state: "pending",
      callbackUrl: "http://old.example/configuration",
    });

    await expect(install._handler(setup.ctx, {})).resolves.toEqual(installed);

    expect(setup.patch).toHaveBeenCalledWith(existing._id, { callbackUrl: customCallbackUrl });
    expect(registrationBody(setup.fetch)).toMatchObject({
      installationId,
      callbackUrl: customCallbackUrl,
      webhookSecret: existing.webhookSecret,
    });
  });

  it.each([callbackUrl, customCallbackUrl])(
    "keeps a valid pending callback %s when automatic URL changes",
    async (storedCallbackUrl) => {
      vi.stubEnv("CONVEX_SITE_URL", "https://other.example/integrations/splitch");
      const setup = installContext({
        ...existing,
        state: "pending",
        callbackUrl: storedCallbackUrl,
      });

      await install._handler(setup.ctx, {});

      expect(setup.patch).not.toHaveBeenCalled();
      expect(registrationBody(setup.fetch).callbackUrl).toBe(storedCallbackUrl);
    },
  );
});

describe("fresh install", () => {
  it.each([
    ["https://dashing-rook-238.convex.site/integrations/splitch", callbackUrl],
    ["https://gateway.chat.zaks.io/integrations/splitch", customCallbackUrl],
  ])(
    "registers the actual HTTP Actions URL %s without CONVEX_CLOUD_URL",
    async (siteUrl, expectedCallback) => {
      vi.stubEnv("CONVEX_CLOUD_URL", undefined);
      vi.stubEnv("CONVEX_SITE_URL", siteUrl);
      const setup = installContext(null);

      await expect(install._handler(setup.ctx, {})).resolves.toEqual(installed);

      expect(setup.insert).toHaveBeenCalledOnce();
      expect(registrationBody(setup.fetch)).toMatchObject({
        callbackUrl: expectedCallback,
        callbackVerification: "hmac-sha256",
      });
    },
  );

  it.each([
    undefined,
    "http://gateway.chat.zaks.io/integrations/splitch",
    "https://127.0.0.1/integrations/splitch",
  ])("rejects a missing or invalid HTTP Actions URL %s before initialization", async (siteUrl) => {
    vi.stubEnv("CONVEX_SITE_URL", siteUrl);
    const setup = installContext(null);

    await expect(install._handler(setup.ctx, {})).rejects.toThrow("CONVEX_SITE_URL");

    expect(setup.runMutation).not.toHaveBeenCalled();
    expect(setup.fetch).not.toHaveBeenCalled();
  });
});

function registrationBody(fetch: ReturnType<typeof vi.fn>) {
  const request = fetch.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(request.body as string);
}

function installContext(initial: typeof existing | null) {
  vi.stubEnv("SPLITCH_API_KEY", "test_key");
  let row = initial;
  const query = () => ({ withIndex: () => ({ unique: async () => row }) });
  const patch = vi.fn(async (_id: string, fields: Record<string, unknown>) => {
    if (!row) throw new Error("installation missing");
    row = { ...row, ...fields };
  });
  const insert = vi.fn(async (_table: string, fields: Record<string, unknown>) => {
    row = { ...existing, ...fields };
  });
  const mutationCtx = { db: { query, patch, insert } } as unknown as MutationCtx;
  const runMutation = vi
    .fn()
    .mockImplementationOnce((_reference, args) => initializeHandler(mutationCtx, args))
    .mockImplementationOnce(async () => {
      if (!row) throw new Error("installation missing");
      row = { ...row, state: "active" };
    });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(installed))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal("fetch", fetch);
  return {
    ctx: { runMutation, runQuery: vi.fn(async () => row) } as unknown as ActionCtx,
    runMutation,
    patch,
    insert,
    fetch,
  };
}
