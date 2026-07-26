import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";

const clientKey = {
  keyId: "ck_staging",
  appId: "app_checkout",
  environmentId: "env_staging",
  keyMaterial: "pk_live_staging",
  originAllowlist: null,
  isOriginOpen: true,
  createdAt: "2026-07-18T00:00:00.000Z",
};

const apiKeyMetadata = {
  keyId: "key_ci",
  appId: "app_checkout",
  environmentId: "env_staging",
  scopes: ["flags:read"],
  createdAt: "2026-07-18T00:00:00.000Z",
};

function sdkWith(response: () => Response) {
  const requests: Request[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input as RequestInfo, init));
    return response();
  });
  return {
    sdk: createControlPlaneSdk({ baseUrl: "https://control-plane.test", fetch: fetcher }),
    requests,
  };
}

describe("control plane sdk Client Key operations", () => {
  it("gets the Environment's public Client Key", async () => {
    const { sdk, requests } = sdkWith(() => Response.json(clientKey));

    const result = await sdk.credentials.clientKey.get({
      appId: "app_checkout",
      environmentId: "env_staging",
    });

    expect(requests[0]?.url).toBe(
      "https://control-plane.test/apps/app_checkout/envs/env_staging/client-key",
    );
    expect(result).toEqual({ ok: true, status: 200, data: clientKey });
  });

  it("patches only the origin allow-list, not the path params", async () => {
    const { sdk, requests } = sdkWith(() =>
      Response.json({ ...clientKey, originAllowlist: ["https://shop.test"], isOriginOpen: false }),
    );

    const result = await sdk.credentials.clientKey.update({
      appId: "app_checkout",
      environmentId: "env_staging",
      originAllowlist: ["https://shop.test"],
    });

    expect(requests[0]?.method).toBe("PATCH");
    await expect(requests[0]?.json()).resolves.toEqual({
      originAllowlist: ["https://shop.test"],
    });
    expect(result.ok && result.data.isOriginOpen).toBe(false);
  });

  it("rotates the Client Key and reports which key it revoked", async () => {
    const { sdk, requests } = sdkWith(() =>
      Response.json({
        newKey: { keyId: "ck_staging_2", keyMaterial: "pk_live_staging_2" },
        revokedKeyId: "ck_staging",
      }),
    );

    const result = await sdk.credentials.clientKey.rotate({
      appId: "app_checkout",
      environmentId: "env_staging",
    });

    expect(requests[0]?.url).toBe(
      "https://control-plane.test/apps/app_checkout/envs/env_staging/client-key/revoke",
    );
    expect(result.ok && result.data.revokedKeyId).toBe("ck_staging");
  });

  it("surfaces a typed refusal instead of a generic transport error", async () => {
    const { sdk } = sdkWith(() =>
      Response.json(
        {
          code: "CREDENTIAL_NOT_FOUND",
          message: "No Client Key for that Environment",
          details: {},
        },
        { status: 404 },
      ),
    );

    await expect(
      sdk.credentials.clientKey.update({
        appId: "app_checkout",
        environmentId: "env_missing",
        rateLimitRps: 10,
      }),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      error: {
        code: "CREDENTIAL_NOT_FOUND",
        message: "No Client Key for that Environment",
        details: {},
      },
    });
  });
});

describe("control plane sdk API Key operations", () => {
  it("lists API Key metadata", async () => {
    const { sdk, requests } = sdkWith(() => Response.json({ items: [apiKeyMetadata] }));

    const result = await sdk.credentials.apiKeys.list({
      appId: "app_checkout",
      environmentId: "env_staging",
    });

    expect(requests[0]?.url).toBe(
      "https://control-plane.test/apps/app_checkout/envs/env_staging/api-keys",
    );
    expect(result).toEqual({ ok: true, status: 200, data: { items: [apiKeyMetadata] } });
  });

  it("mints an API Key and returns the once-only secret", async () => {
    const { sdk, requests } = sdkWith(() =>
      Response.json({ credential: apiKeyMetadata, value: "sk_once_only" }),
    );

    const result = await sdk.credentials.apiKeys.create({
      appId: "app_checkout",
      environmentId: "env_staging",
      scopes: ["flags:read"],
    });

    expect(requests[0]?.method).toBe("POST");
    await expect(requests[0]?.json()).resolves.toEqual({ scopes: ["flags:read"] });
    expect(result.ok && result.data.value).toBe("sk_once_only");
  });

  it("revokes an API Key", async () => {
    const { sdk, requests } = sdkWith(() =>
      Response.json({ keyId: "key_ci", revokedAt: "2026-07-19T00:00:00.000Z" }),
    );

    const result = await sdk.credentials.apiKeys.revoke({
      appId: "app_checkout",
      environmentId: "env_staging",
      keyId: "key_ci",
    });

    expect(requests[0]?.url).toBe(
      "https://control-plane.test/apps/app_checkout/envs/env_staging/api-keys/key_ci/revoke",
    );
    expect(result.ok && result.data.keyId).toBe("key_ci");
  });

  it("surfaces a typed refusal when revoking an unknown key", async () => {
    const { sdk } = sdkWith(() =>
      Response.json(
        { code: "CREDENTIAL_NOT_FOUND", message: "Unknown API Key", details: {} },
        { status: 404 },
      ),
    );

    await expect(
      sdk.credentials.apiKeys.revoke({
        appId: "app_checkout",
        environmentId: "env_staging",
        keyId: "key_gone",
      }),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      error: { code: "CREDENTIAL_NOT_FOUND", message: "Unknown API Key", details: {} },
    });
  });

  /**
   * Provision-don't-read (ADR-0022) enforced at runtime, not just in the types:
   * the APIKey leaf is `.strict()`, so a Worker that regressed and echoed key
   * material on a LIST response cannot have that secret pass silently through the
   * SDK into a caller. It fails the parse loudly (ADR-0036) instead.
   */
  it("refuses to parse a list response that leaks key material", async () => {
    const { sdk } = sdkWith(() =>
      Response.json({
        items: [{ ...apiKeyMetadata, keyMaterial: "sk_leaked_by_a_worker_regression" }],
      }),
    );

    await expect(
      sdk.credentials.apiKeys.list({ appId: "app_checkout", environmentId: "env_staging" }),
    ).rejects.toThrow("api_keys_list returned an invalid response body");
  });
});
