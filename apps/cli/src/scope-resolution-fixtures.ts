import { type FakeResponse, oauthTokenMint } from "./test-fixtures.js";

const scopeStamp = "2026-07-03T00:00:00.000Z";

/**
 * Stubs for the live App/Environment selector resolution that every command
 * runs when `--app` / `--env` (or SPLITCH_*) carry a flag/env selector. Put
 * these ahead of the operation stub so FakeCliTransport matches the list
 * calls first.
 */
export function scopeResolutionStubs(options?: {
  readonly appId?: string;
  readonly appKey?: string;
  readonly orgId?: string;
  readonly environments?: ReadonlyArray<{
    readonly id: string;
    readonly key: string;
    readonly name?: string;
  }>;
}): FakeResponse[] {
  const appId = options?.appId ?? "app_1";
  const appKey = options?.appKey ?? "checkout";
  const orgId = options?.orgId ?? "org_1";
  const environments = options?.environments ?? [
    { id: "env_1", key: "dev", name: "Dev" },
    { id: "env_prod", key: "prod", name: "Prod" },
    { id: "env_target", key: "target", name: "Target" },
    { id: "env_flag", key: "flag-env", name: "Flag Env" },
  ];
  const apps = [
    {
      id: appId,
      organizationId: orgId,
      key: appKey,
      name: "Checkout",
      createdAt: scopeStamp,
      updatedAt: scopeStamp,
    },
  ];
  if (appId !== "app_flag") {
    apps.push({
      id: "app_flag",
      organizationId: orgId,
      key: "flag-app",
      name: "Flag App",
      createdAt: scopeStamp,
      updatedAt: scopeStamp,
    });
  }
  const envItemsFor = (ownerAppId: string) =>
    environments.map((environment) => ({
      ...environment,
      appId: ownerAppId,
      policy: {
        variantAvailability: "allow",
        targetingRolloutValue: "allow",
        enabledState: "allow",
        startExperimentRun: "allow",
      },
      createdAt: scopeStamp,
      updatedAt: scopeStamp,
    }));
  return [
    oauthTokenMint(),
    {
      match: (request) =>
        request.method === "GET" && /\/orgs\/?$/.test(new URL(request.url).pathname),
      status: 200,
      body: {
        items: [
          {
            id: orgId,
            name: "Acme",
            slug: "acme",
            plan: "free",
            createdAt: scopeStamp,
            updatedAt: scopeStamp,
          },
        ],
      },
    },
    {
      match: (request) =>
        request.method === "GET" && new URL(request.url).pathname === `/orgs/${orgId}/apps`,
      status: 200,
      body: { items: apps },
    },
    {
      match: (request) =>
        request.method === "GET" && new URL(request.url).pathname === `/apps/${appId}/envs`,
      status: 200,
      body: { items: envItemsFor(appId) },
    },
    {
      match: (request) =>
        request.method === "GET" && new URL(request.url).pathname === "/apps/app_flag/envs",
      status: 200,
      body: { items: envItemsFor("app_flag") },
    },
  ];
}
