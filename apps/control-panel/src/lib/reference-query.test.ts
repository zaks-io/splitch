import { createControlPlaneSdk, type FlagConfigGetOutput } from "@splitch/control-plane-sdk";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createFlagConfigApi } from "./flag-config-api";
import { loadFlagConfigRoute, updateFlagConfigRoute } from "./flag-config-route";
import { referenceFlagConfigQuery } from "./reference-query";

const scope = { appId: "app_1", environmentId: "env_1" };
const initialConfig = config({ version: 1, enabled: false });

describe("reference Flag Configuration route query flow", () => {
  it("seeds a real typed SDK loader read into the QueryClient", async () => {
    let reads = 0;
    const api = sdkApi(async (request) => {
      reads += 1;
      expect(request.url).toBe(
        "https://control-plane.test/apps/app_1/envs/env_1/flags/flag_1/config",
      );
      return Response.json(initialConfig);
    });
    const queryClient = queryClientForTest();

    await expect(
      loadFlagConfigRoute({ queryClient, api, scope, flagId: "flag_1" }),
    ).resolves.toBeUndefined();
    expect(reads).toBe(1);
    expect(
      queryClient.getQueryData(referenceFlagConfigQuery(api, scope, "flag_1").queryKey),
    ).toEqual(initialConfig);
  });

  it("does not write optimistically and refetches only after a confirmed 200", async () => {
    let readConfig = initialConfig;
    let resolveUpdate: ((response: Response) => void) | undefined;
    const api = sdkApi((request) => {
      if (request.method === "PATCH") {
        return new Promise<Response>((resolve) => {
          resolveUpdate = resolve;
        });
      }
      return Promise.resolve(Response.json(readConfig));
    });
    const queryClient = queryClientForTest();
    await loadFlagConfigRoute({ queryClient, api, scope, flagId: "flag_1" });
    const query = referenceFlagConfigQuery(api, scope, "flag_1");
    const observer = new QueryObserver(queryClient, query);
    const unsubscribe = observer.subscribe(() => undefined);

    const mutation = updateFlagConfigRoute({
      queryClient,
      api,
      scope,
      flagId: "flag_1",
      patch: { enabled: true, idempotency_key: "config-update-1" },
    });
    expect(queryClient.getQueryData(query.queryKey)).toEqual(initialConfig);

    readConfig = config({ version: 2, enabled: true });
    resolveUpdate?.(Response.json({ config: readConfig, approvalRequest: null }));

    await expect(mutation).resolves.toEqual({
      ok: true,
      data: readConfig,
      approvalRequest: null,
    });
    expect(queryClient.getQueryData(query.queryKey)).toEqual(readConfig);
    unsubscribe();
  });

  it("retains cached state and surfaces a typed SDK 400 field error", async () => {
    const api = sdkApi(async (request) =>
      request.method === "PATCH"
        ? Response.json(
            {
              code: "VALIDATION_ERROR",
              message: "Invalid Flag Configuration",
              details: { issues: [{ path: ["enabled"], message: "Cannot disable this Flag" }] },
            },
            { status: 400 },
          )
        : Response.json(initialConfig),
    );
    const queryClient = queryClientForTest();
    await loadFlagConfigRoute({ queryClient, api, scope, flagId: "flag_1" });

    await expect(
      updateFlagConfigRoute({
        queryClient,
        api,
        scope,
        flagId: "flag_1",
        patch: { enabled: true, idempotency_key: "config-update-2" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "field",
        message: "Invalid Flag Configuration",
        fields: [
          { field: "enabled", code: "VALIDATION_ERROR", message: "Cannot disable this Flag" },
        ],
      },
    });
    expect(cachedConfig(queryClient, api)).toEqual(initialConfig);
  });

  it("surfaces a typed SDK 403 as a tier error without changing the cache", async () => {
    const api = sdkApi(async (request) =>
      request.method === "PATCH"
        ? Response.json(
            { code: "FORBIDDEN", message: "Admin role required", details: {} },
            { status: 403 },
          )
        : Response.json(initialConfig),
    );
    const queryClient = queryClientForTest();
    await loadFlagConfigRoute({ queryClient, api, scope, flagId: "flag_1" });

    await expect(
      updateFlagConfigRoute({
        queryClient,
        api,
        scope,
        flagId: "flag_1",
        patch: { enabled: true, idempotency_key: "config-update-3" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "tier", message: "Admin role required" },
    });
    expect(cachedConfig(queryClient, api)).toEqual(initialConfig);
  });
});

function sdkApi(handler: (request: Request) => Promise<Response>) {
  return createFlagConfigApi(
    createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: async (input, init) =>
        handler(input instanceof Request ? input : new Request(input, init)),
    }).flags,
    { authorization: "Bearer test-control-plane-token" },
  );
}

function config(input: { version: number; enabled: boolean }): FlagConfigGetOutput {
  return {
    flagId: "flag_1",
    environmentId: "env_1",
    availableVariantNames: ["control", "treatment"],
    targetingRules: [],
    rollout: null,
    experiment: null,
    ...input,
  };
}

function queryClientForTest() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function cachedConfig(queryClient: QueryClient, api: ReturnType<typeof sdkApi>) {
  return queryClient.getQueryData(referenceFlagConfigQuery(api, scope, "flag_1").queryKey);
}
