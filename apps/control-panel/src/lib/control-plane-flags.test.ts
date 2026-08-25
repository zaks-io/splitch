import {
  CONTROL_PANEL_DELEGATION_HEADER,
  verifyControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { describe, expect, it, vi } from "vitest";
import { createControlPanelFlagsClient } from "./control-plane-apps";
import { booleanPresetDraft, flagCreateInput } from "./create-flag-model";

const TOKEN_HASH = "b".repeat(64);
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";

describe("Control Panel Flags transport", () => {
  it("reads Flag definitions and Configuration only through the scoped binding", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request);
      return request.url.endsWith("/flags")
        ? Response.json({ items: [createdFlag()], readTruncated: false, readLimit: 200 })
        : Response.json({
            flagId: "flag_checkout",
            environmentId: "env_dev",
            version: 1,
            enabled: true,
            availableVariantNames: ["disabled", "enabled"],
            targetingRules: [],
            rollout: null,
            experiment: null,
          });
    });
    const flags = createControlPanelFlagsClient(
      { fetch: fetcher } as unknown as Fetcher,
      { actorId: "user_checkout", sessionExpiresAt: 1_800_003_600 },
      "env_dev",
      DELEGATION_SECRET,
      {
        nowSeconds: () => 1_800_000_000,
        nonce: () => `nonce_read_${requests.length}_1234567890`,
      },
    );

    await expect(flags.list({ appId: "app_checkout" })).resolves.toMatchObject({ ok: true });
    await expect(
      flags.getConfig({
        appId: "app_checkout",
        environmentId: "env_dev",
        flagId: "flag_checkout",
      }),
    ).resolves.toMatchObject({ ok: true, data: { flagId: "flag_checkout" } });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requests.map((request) => request.url)).toEqual([
      "https://control-plane.internal/apps/app_checkout/flags",
      "https://control-plane.internal/apps/app_checkout/envs/env_dev/flags/flag_checkout/config",
    ]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-splitch-panel-session")).toBeNull();
    }
    await expect(
      verifyControlPanelDelegation(
        requests[1]?.headers.get(CONTROL_PANEL_DELEGATION_HEADER) ?? null,
        requests[1] as Request,
        {
          id: "flag_config_get",
          appId: "app_checkout",
          environmentId: "env_dev",
          flagId: "flag_checkout",
        },
        DELEGATION_SECRET,
        1_800_000_000,
      ),
    ).resolves.toMatchObject({
      operation: {
        id: "flag_config_get",
        appId: "app_checkout",
        environmentId: "env_dev",
        flagId: "flag_checkout",
      },
    });
  });

  it("sends the guided boolean catalog through an authenticated scoped delegation", async () => {
    let capturedRequest: Request | undefined;
    const fetcher = vi.fn(async (request: Request) => {
      capturedRequest = request;
      return Response.json(createdFlag());
    });
    const flags = createControlPanelFlagsClient(
      { fetch: fetcher } as unknown as Fetcher,
      { actorId: "user_checkout", sessionExpiresAt: 1_800_003_600 },
      "env_dev",
      DELEGATION_SECRET,
      { nowSeconds: () => 1_800_000_000, nonce: () => "nonce_1234567890abcdef" },
    );

    const result = await flags.create(
      flagCreateInput(
        "app_checkout",
        { ...booleanPresetDraft(), name: "New Checkout", key: "new-checkout" },
        "idem-1",
      ),
    );
    const request = capturedRequest;

    expect(result).toMatchObject({ ok: true, data: { key: "new-checkout" } });
    expect(request?.headers.get("x-splitch-panel-session")).toBeNull();
    expect(request?.headers.get("x-splitch-panel-environment")).toBe("env_dev");
    expect(request?.headers.get("authorization")).toBeNull();
    const operation = {
      id: "flags_create",
      appId: "app_checkout",
      environmentId: "env_dev",
    } as const;
    const delegation = await verifyControlPanelDelegation(
      request?.headers.get(CONTROL_PANEL_DELEGATION_HEADER) ?? null,
      request?.clone() as Request,
      operation,
      DELEGATION_SECRET,
      1_800_000_000,
    );
    expect(JSON.stringify(delegation)).not.toContain(TOKEN_HASH);
    expect(delegation).toMatchObject({
      operation: { id: "flags_create", appId: "app_checkout", environmentId: "env_dev" },
      actorId: "user_checkout",
      expiresAt: 1_800_000_030,
      nonce: "nonce_1234567890abcdef",
    });
    await expect(request?.clone().json()).resolves.toMatchObject({
      appId: "app_checkout",
      key: "new-checkout",
      // The caller's key reaches the Control Plane verbatim, which is what makes
      // a retried submission replay instead of minting a second Flag.
      idempotency_key: "idem-1",
      schema: { type: "boolean" },
      variants: [
        { name: "disabled", value: false, isDefault: true },
        { name: "enabled", value: true, isDefault: false },
      ],
    });
  });
});

describe("Control Panel flag_get transport", () => {
  it('mints a flag_get claim for flags.get({ by: "key" }) through the binding', async () => {
    let capturedRequest: Request | undefined;
    const fetcher = vi.fn(async (request: Request) => {
      capturedRequest = request;
      return Response.json(createdFlag());
    });
    const flags = createControlPanelFlagsClient(
      { fetch: fetcher } as unknown as Fetcher,
      { actorId: "user_checkout", sessionExpiresAt: 1_800_003_600 },
      "env_dev",
      DELEGATION_SECRET,
      { nowSeconds: () => 1_800_000_000, nonce: () => "nonce_flag_get_1234567890" },
    );

    await expect(
      flags.get({ appId: "app_checkout", flagId: "new-checkout", by: "key" }),
    ).resolves.toMatchObject({ ok: true, data: { key: "new-checkout" } });

    expect(capturedRequest?.url).toBe(
      "https://control-plane.internal/apps/app_checkout/flags/new-checkout?by=key",
    );
    await expect(
      verifyControlPanelDelegation(
        capturedRequest?.headers.get(CONTROL_PANEL_DELEGATION_HEADER) ?? null,
        capturedRequest as Request,
        {
          id: "flag_get",
          appId: "app_checkout",
          environmentId: "env_dev",
          flagId: "new-checkout",
          by: "key",
        },
        DELEGATION_SECRET,
        1_800_000_000,
      ),
    ).resolves.toMatchObject({
      operation: {
        id: "flag_get",
        appId: "app_checkout",
        environmentId: "env_dev",
        flagId: "new-checkout",
        by: "key",
      },
    });
  });
});

function createdFlag() {
  return {
    id: "flag_checkout",
    appId: "app_checkout",
    key: "new-checkout",
    name: "New Checkout",
    schema: { type: "boolean" },
    variants: [
      { id: "var_disabled", name: "disabled", value: false },
      { id: "var_enabled", name: "enabled", value: true },
    ],
    defaultVariantId: "var_disabled",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}
