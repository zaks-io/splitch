import { getRoute } from "@splitch/sdk/control-plane";
import { describe, expect, it, vi } from "vitest";
import { withAuthorizationRetry } from "./auth.js";
import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "./auth-binding.js";
import type { CliCredentialFile } from "./credentials.js";
import { operationAuthorization } from "./execute-operations.js";
import { storedCredential } from "./test-fixtures.js";

describe("membership-wide read token caching", () => {
  it("selects wide authority only for selector-free Control Plane reads", () => {
    const organizationsList = getRoute("organizations_list");
    const cloudflareInstallationGet = getRoute("cloudflare_installations_get");
    const appGet = getRoute("apps_get");
    if (!organizationsList || !cloudflareInstallationGet || !appGet) {
      throw new Error("expected authorization test routes to be registered");
    }

    expect(operationAuthorization(organizationsList, {})).toEqual({
      kind: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
    });
    expect(operationAuthorization(cloudflareInstallationGet, {})).toBeUndefined();
    expect(operationAuthorization(appGet, { appId: "app_1" })).toEqual({
      kind: "app",
      selector: "app_1",
    });
  });

  it("mints once for scope-free reads and reuses the cached token", async () => {
    let stored: CliCredentialFile | null = {
      ...storedCredential(),
      credential: {
        ...storedCredential().credential,
        accessTokenBinding: "app:app_1",
      },
    };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("authorization")).toBe(MEMBERSHIP_WIDE_READ_AUTHORIZATION);
      expect(body.has("app")).toBe(false);
      expect(body.has("org")).toBe(false);
      return Response.json({
        access_token: "wide-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      });
    });
    const credentialStore = {
      load: async () => stored,
      save: async (next: CliCredentialFile) => {
        stored = next;
      },
      clear: async () => {
        stored = null;
      },
    };
    const run = vi.fn(async () => ({ status: 200, value: "ok" }));
    const authorization = { kind: MEMBERSHIP_WIDE_READ_AUTHORIZATION } as const;
    const deps = {
      credentialStore,
      fetch: fetchImpl as typeof fetch,
      platformTarget: "local",
    };

    await expect(withAuthorizationRetry(deps, run, authorization)).resolves.toBe("ok");
    await expect(withAuthorizationRetry(deps, run, authorization)).resolves.toBe("ok");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(run).toHaveBeenNthCalledWith(1, "Bearer wide-access-token");
    expect(run).toHaveBeenNthCalledWith(2, "Bearer wide-access-token");
    expect(stored?.credential.accessTokenBinding).toBe(MEMBERSHIP_WIDE_READ_AUTHORIZATION);
  });

  it("does not reuse a cached wide token for a scope-free mutation", async () => {
    let stored: CliCredentialFile | null = {
      ...storedCredential(),
      credential: {
        ...storedCredential().credential,
        accessToken: "wide-access-token",
        accessTokenBinding: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
      },
    };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.has("authorization")).toBe(false);
      expect(body.has("app")).toBe(false);
      expect(body.has("org")).toBe(false);
      return Response.json({
        access_token: "selector-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
        app_id: "app_1",
      });
    });
    const credentialStore = {
      load: async () => stored,
      save: async (next: CliCredentialFile) => {
        stored = next;
      },
      clear: async () => {
        stored = null;
      },
    };
    const run = vi.fn(async () => ({ status: 200, value: "ok" }));

    await expect(
      withAuthorizationRetry(
        { credentialStore, fetch: fetchImpl as typeof fetch, platformTarget: "local" },
        run,
      ),
    ).resolves.toBe("ok");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("Bearer selector-access-token");
    expect(stored?.credential.accessTokenBinding).toBe("app:app_1");
  });
});
