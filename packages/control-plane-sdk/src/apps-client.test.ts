import { boundListRead } from "@splitch/contracts";
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

  it("lists an Organization's Apps", async () => {
    const { sdk, requests } = appsSdk(() => Response.json(boundListRead([createdApp.app])));

    const result = await sdk.apps.list({ orgId: "org_acme" });

    expect(requests[0]?.url).toBe("https://control-plane.test/orgs/org_acme/apps");
    expect(result).toEqual({ ok: true, status: 200, data: boundListRead([createdApp.app]) });
  });

  it("gets one App", async () => {
    const { sdk, requests } = appsSdk(() => Response.json(createdApp.app));

    const result = await sdk.apps.get({ appId: "app_checkout" });

    expect(requests[0]?.url).toBe("https://control-plane.test/apps/app_checkout");
    expect(result).toEqual({ ok: true, status: 200, data: createdApp.app });
  });

  it("patches an App without sending the immutable key", async () => {
    const { sdk, requests } = appsSdk(() =>
      Response.json({ ...createdApp.app, name: "Checkout v2" }),
    );

    const result = await sdk.apps.update({ appId: "app_checkout", name: "Checkout v2" });

    expect(requests[0]?.method).toBe("PATCH");
    await expect(requests[0]?.json()).resolves.toEqual({ name: "Checkout v2" });
    expect(result.ok && result.data.name).toBe("Checkout v2");
  });

  it("deletes an App", async () => {
    const { sdk, requests } = appsSdk(() => Response.json({ deleted: true }));

    const result = await sdk.apps.delete({ appId: "app_checkout" });

    expect(requests[0]?.method).toBe("DELETE");
    expect(result).toEqual({ ok: true, status: 200, data: { deleted: true } });
  });

  it("passes dryRun and force query flags on App delete", async () => {
    const { sdk, requests } = appsSdk(() =>
      Response.json({ deleted: false, dryRun: true, blockers: [] }),
    );

    await sdk.apps.delete({ appId: "app_checkout", dryRun: true });
    expect(new URL(requests[0]?.url ?? "").searchParams.get("dryRun")).toBe("true");

    await sdk.apps.delete({ appId: "app_checkout", force: true });
    expect(new URL(requests[1]?.url ?? "").searchParams.get("force")).toBe("true");
  });

  it("surfaces the Worker's refusal to delete an App with a running Experiment", async () => {
    const experimentRunning = {
      code: "EXPERIMENT_RUNNING",
      message: "Stop the running Experiment first",
      details: {
        experimentId: "exp_checkout",
        runningRunId: "run_live",
        attemptedOp: "apps_delete",
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    };
    const { sdk } = appsSdk(() => Response.json(experimentRunning, { status: 409 }));

    await expect(sdk.apps.delete({ appId: "app_checkout" })).resolves.toEqual({
      ok: false,
      status: 409,
      error: experimentRunning,
    });
  });

  it("returns the typed per-Environment App attention rollup", async () => {
    let capturedUrl = "";
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async (input) => {
        capturedUrl = input instanceof Request ? input.url : String(input);
        return Response.json({
          appId: "app_local",
          items: [
            {
              environmentId: "env_prod",
              state: "attention",
              srm: true,
              guardrail: false,
            },
          ],
        });
      },
    });

    const result = await sdk.apps.getAttentionRollup({ appId: "app_local" });

    expect(capturedUrl).toBe("https://control-plane.test/apps/app_local/attention-rollup");
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: {
        appId: "app_local",
        items: [
          {
            environmentId: "env_prod",
            state: "attention",
            srm: true,
            guardrail: false,
          },
        ],
      },
    });
  });
});

function appsSdk(response: () => Response) {
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
