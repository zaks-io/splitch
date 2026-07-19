import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_PANEL_IDENTITY_HEADER,
  parseControlPanelIdentity,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { createControlPanelAppsClient } from "./control-plane-apps";

const ACTOR = { actorId: "user_acme", sessionExpiresAt: 1_800_003_600 };
const TOKEN_HASH = "a".repeat(64);

describe("Control Panel Apps transport", () => {
  it("carries only an operation-scoped single-use identity over the Worker binding", async () => {
    let capturedRequest: Request | undefined;
    const fetcher = vi.fn(async (request: Request) => {
      capturedRequest = request;
      return Response.json(createdApp());
    });
    const apps = createControlPanelAppsClient({ fetch: fetcher } as unknown as Fetcher, ACTOR, {
      nowSeconds: () => 1_800_000_000,
      nonce: () => "nonce_1234567890abcdef",
    });

    const result = await apps.create({
      orgId: "org_acme",
      organizationId: "org_acme",
      name: "Checkout",
      key: "checkout",
    });

    const request = capturedRequest;
    expect(request).toBeInstanceOf(Request);
    expect(request?.headers.get("x-splitch-panel-session")).toBeNull();
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("cookie")).toBeNull();
    expect(await request?.clone().text()).not.toContain(TOKEN_HASH);
    expect(
      parseControlPanelIdentity(request?.headers.get(CONTROL_PANEL_IDENTITY_HEADER) ?? null),
    ).toEqual({
      version: 1,
      operation: { id: "apps_create", orgId: "org_acme" },
      actorId: ACTOR.actorId,
      expiresAt: 1_800_000_030,
      nonce: "nonce_1234567890abcdef",
    });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(JSON.stringify(result)).not.toContain(TOKEN_HASH);
  });

  it("preserves typed Worker refusals for the server function caller", async () => {
    const apps = createControlPanelAppsClient(
      {
        fetch: async () =>
          Response.json(
            {
              code: "FORBIDDEN",
              message: "Organization role does not permit this action",
              details: {},
            },
            { status: 403 },
          ),
      } as unknown as Fetcher,
      ACTOR,
    );

    await expect(
      apps.create({
        orgId: "org_acme",
        organizationId: "org_acme",
        name: "Checkout",
        key: "checkout",
      }),
    ).resolves.toEqual({
      ok: false,
      status: 403,
      error: {
        code: "FORBIDDEN",
        message: "Organization role does not permit this action",
        details: {},
      },
    });
  });

  it("rejects an expired panel session before dispatch", async () => {
    const apps = createControlPanelAppsClient(
      { fetch: vi.fn() } as unknown as Fetcher,
      { actorId: "user_acme", sessionExpiresAt: 99 },
      { nowSeconds: () => 100 },
    );
    await expect(
      apps.create({
        orgId: "org_acme",
        organizationId: "org_acme",
        name: "Checkout",
        key: "checkout",
      }),
    ).rejects.toThrow("control-panel downstream identity is invalid");
  });
});

function createdApp() {
  const now = "2026-07-18T00:00:00.000Z";
  const policy = {
    variantAvailability: "allow" as const,
    targetingRolloutValue: "allow" as const,
    enabledState: "allow" as const,
    startExperimentRun: "allow" as const,
  };
  return {
    app: {
      id: "app_checkout",
      organizationId: "org_acme",
      name: "Checkout",
      key: "checkout",
      createdAt: now,
      updatedAt: now,
    },
    environments: [
      {
        id: "env_dev",
        appId: "app_checkout",
        key: "dev",
        name: "Dev",
        policy,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "env_prod",
        appId: "app_checkout",
        key: "prod",
        name: "Prod",
        policy,
        createdAt: now,
        updatedAt: now,
      },
    ],
    clientKeys: [
      {
        keyId: "ck_dev",
        appId: "app_checkout",
        environmentId: "env_dev",
        keyMaterial: "pk_dev",
        isOriginOpen: true,
        createdAt: now,
      },
      {
        keyId: "ck_prod",
        appId: "app_checkout",
        environmentId: "env_prod",
        keyMaterial: "pk_prod",
        isOriginOpen: true,
        createdAt: now,
      },
    ],
  };
}
