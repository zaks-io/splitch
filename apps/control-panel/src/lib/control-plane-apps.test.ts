import { describe, expect, it, vi } from "vitest";
import { createControlPanelAppsClient } from "./control-plane-apps";

const TOKEN_HASH = "a".repeat(64);

describe("Control Panel Apps transport", () => {
  it("carries only the server-side session handle over the Worker binding", async () => {
    let capturedRequest: Request | undefined;
    const fetcher = vi.fn(async (request: Request) => {
      capturedRequest = request;
      return Response.json(createdApp());
    });
    const apps = createControlPanelAppsClient({ fetch: fetcher } as unknown as Fetcher, TOKEN_HASH);

    const result = await apps.create({
      orgId: "org_acme",
      organizationId: "org_acme",
      name: "Checkout",
      key: "checkout",
    });

    const request = capturedRequest;
    expect(request).toBeInstanceOf(Request);
    expect(request?.headers.get("x-splitch-panel-session")).toBe(TOKEN_HASH);
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("cookie")).toBeNull();
    expect(await request?.clone().text()).not.toContain(TOKEN_HASH);
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
      TOKEN_HASH,
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

  it("rejects malformed session handles before dispatch", () => {
    expect(() =>
      createControlPanelAppsClient({ fetch: vi.fn() } as unknown as Fetcher, "browser-value"),
    ).toThrow("control-panel session handle is invalid");
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
