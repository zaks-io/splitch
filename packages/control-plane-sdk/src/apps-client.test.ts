import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";

const createdApp = {
  app: {
    id: "app_checkout",
    organizationId: "org_acme",
    name: "Checkout",
    key: "checkout",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  },
  environments: [
    environment("env_dev", "dev", "Dev", "allow"),
    environment("env_prod", "prod", "Prod", "confirm"),
  ],
  clientKeys: [
    clientKey("ck_dev", "env_dev", "pk_dev"),
    clientKey("ck_prod", "env_prod", "pk_prod"),
  ],
};

describe("control plane sdk Apps client", () => {
  it("calls the existing apps_create route and parses its typed response", async () => {
    let capturedRequest: RequestInfo | URL | undefined;
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      capturedRequest = request;
      return Response.json(createdApp);
    });
    const sdk = createControlPlaneSdk({ baseUrl: "https://control-plane.test", fetch: fetcher });

    const result = await sdk.apps.create({
      orgId: "org_acme",
      organizationId: "org_acme",
      name: "Checkout",
      key: "checkout",
    });

    const request = capturedRequest;
    expect(request instanceof Request ? request.url : String(request)).toBe(
      "https://control-plane.test/orgs/org_acme/apps",
    );
    expect(result).toEqual({ ok: true, status: 200, data: createdApp });
  });

  it("preserves the Worker's typed refusal instead of throwing a generic transport error", async () => {
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async () =>
        Response.json(
          {
            code: "FORBIDDEN",
            message: "Organization role does not permit this action",
            details: {},
          },
          { status: 403 },
        ),
    });

    await expect(
      sdk.apps.create({
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
});

function environment(id: string, key: string, name: string, level: "allow" | "confirm") {
  return {
    id,
    appId: "app_checkout",
    key,
    name,
    policy: {
      variantAvailability: level,
      targetingRolloutValue: level,
      enabledState: level,
      startExperimentRun: level,
    },
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}

function clientKey(keyId: string, environmentId: string, keyMaterial: string) {
  return {
    keyId,
    appId: "app_checkout",
    environmentId,
    keyMaterial,
    isOriginOpen: true,
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}
