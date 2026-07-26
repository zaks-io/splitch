import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";

const environment = {
  id: "env_staging",
  appId: "app_checkout",
  key: "staging",
  name: "Staging",
  policy: {
    variantAvailability: "allow" as const,
    targetingRolloutValue: "allow" as const,
    enabledState: "confirm" as const,
    startExperimentRun: "confirm" as const,
  },
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
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

describe("control plane sdk Environments client", () => {
  it("lists Environments for an App", async () => {
    const { sdk, requests } = sdkWith(() => Response.json({ items: [environment] }));

    const result = await sdk.environments.list({ appId: "app_checkout" });

    expect(requests[0]?.url).toBe("https://control-plane.test/apps/app_checkout/envs");
    expect(requests[0]?.method).toBe("GET");
    expect(result).toEqual({ ok: true, status: 200, data: { items: [environment] } });
  });

  it("creates an Environment and parses the Environment leaf", async () => {
    const { sdk, requests } = sdkWith(() => Response.json(environment));

    const result = await sdk.environments.create({
      appId: "app_checkout",
      key: "staging",
      name: "Staging",
    });

    expect(requests[0]?.method).toBe("POST");
    await expect(requests[0]?.json()).resolves.toEqual({ key: "staging", name: "Staging" });
    expect(result).toEqual({ ok: true, status: 200, data: environment });
  });

  it("gets one Environment including its inline Policy", async () => {
    const { sdk, requests } = sdkWith(() => Response.json(environment));

    const result = await sdk.environments.get({
      appId: "app_checkout",
      environmentId: "env_staging",
    });

    expect(requests[0]?.url).toBe("https://control-plane.test/apps/app_checkout/envs/env_staging");
    expect(result.ok && result.data.policy.enabledState).toBe("confirm");
  });

  it("patches an Environment without sending the path params in the body", async () => {
    const { sdk, requests } = sdkWith(() => Response.json(environment));

    await sdk.environments.update({
      appId: "app_checkout",
      environmentId: "env_staging",
      name: "Staging",
    });

    expect(requests[0]?.method).toBe("PATCH");
    await expect(requests[0]?.json()).resolves.toEqual({ name: "Staging" });
  });

  it("deletes an Environment", async () => {
    const { sdk, requests } = sdkWith(() => Response.json({ deleted: true }));

    const result = await sdk.environments.delete({
      appId: "app_checkout",
      environmentId: "env_staging",
    });

    expect(requests[0]?.method).toBe("DELETE");
    expect(result).toEqual({ ok: true, status: 200, data: { deleted: true } });
  });

  it("surfaces the Worker's typed refusal when deleting the last Environment", async () => {
    const { sdk } = sdkWith(() =>
      Response.json(
        {
          code: "LAST_ENVIRONMENT_REQUIRED",
          message: "An App must keep at least one Environment",
          details: { appId: "app_checkout" },
        },
        { status: 409 },
      ),
    );

    await expect(
      sdk.environments.delete({ appId: "app_checkout", environmentId: "env_staging" }),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      error: {
        code: "LAST_ENVIRONMENT_REQUIRED",
        message: "An App must keep at least one Environment",
        details: { appId: "app_checkout" },
      },
    });
  });
});
