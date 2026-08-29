import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";

describe("canonical Environment selector recovery", () => {
  it("forwards by=id on every Environment-scoped typed operation without leaking it into bodies", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json(
        { code: "FORBIDDEN", message: "Forbidden", details: {} },
        { status: 403 },
      );
    });
    const sdk = createControlPlaneSdk({ baseUrl: "https://control-plane.test", fetch: fetcher });
    const scope = { appId: "app_checkout", environmentId: "env_prod", by: "id" } as const;
    const experiment = { ...scope, experimentId: "exp_checkout" };
    const flag = { ...scope, flagId: "flag_checkout" };

    await sdk.environments.get(scope);
    await sdk.environments.update({ ...scope, name: "Production" });
    await sdk.environments.delete(scope);
    await sdk.flags.getConfig(flag);
    await sdk.flags.updateConfig({ ...flag, enabled: true, idempotency_key: "config-1" });
    await sdk.flags.replaceTargetingRules({
      ...flag,
      targetingRules: [],
      idempotency_key: "targeting-1",
    });
    await sdk.flags.promote({
      appId: scope.appId,
      targetEnvironmentId: scope.environmentId,
      flagId: flag.flagId,
      by: "id",
      fromEnvironmentId: "env_dev",
      select: { enabled: true },
      idempotency_key: "promote-1",
    });
    await sdk.experiments.list(scope);
    await sdk.experiments.create({
      ...scope,
      key: "checkout",
      name: "Checkout",
      flagId: flag.flagId,
      targetingKey: "user_id",
      targetingKeyType: "user",
      metrics: [],
      guardrailMetrics: [],
      confidenceLevel: 0.95,
      conversionWindowMs: 0,
      dimensions: [],
      idempotency_key: "experiment-1",
    });
    await sdk.experiments.get(experiment);
    await sdk.experiments.update({ ...experiment, name: "Checkout" });
    await sdk.experiments.start({ ...experiment, idempotency_key: "run-1" });
    await sdk.experiments.delete(experiment);
    await sdk.credentials.clientKey.get(scope);
    await sdk.credentials.clientKey.update({ ...scope, originAllowlist: null });
    await sdk.credentials.clientKey.rotate(scope);
    await sdk.credentials.apiKeys.list(scope);
    await sdk.credentials.apiKeys.create({ ...scope, scopes: ["data-plane:evaluate"] });
    await sdk.credentials.apiKeys.revoke({ ...scope, keyId: "key_ci" });

    expect(requests).toHaveLength(19);
    for (const request of requests) {
      expect(new URL(request.url).searchParams.get("by"), request.url).toBe("id");
      if (request.body) {
        await expect(request.clone().text()).resolves.not.toContain('"by"');
      }
    }
  });
});
