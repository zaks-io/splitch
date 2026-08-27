import { type FakeResponse, oauthTokenMint } from "./test-fixtures.js";

const scopeStamp = "2026-07-03T00:00:00.000Z";

/**
 * Stubs for the live App/Environment selector resolution that every command
 * runs when `--app` / `--env` (or SPLITCH_*) carry a flag/env selector. Put
 * these ahead of the operation stub so FakeCliTransport matches the list
 * calls first.
 *
 * Does NOT stub `flags_list` — that operation shares a URL with Flag key
 * resolution. Compose `flagsListStub` explicitly when a `:flagId` command needs
 * catalog resolution, so a future `flags list` test cannot pass against a
 * buried scope stub by accident.
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
        readLimit: 200,
        readTruncated: false,
        cursor: null,
      },
    },
    {
      match: (request) =>
        request.method === "GET" && new URL(request.url).pathname === `/orgs/${orgId}/apps`,
      status: 200,
      body: { items: apps, readLimit: 200, readTruncated: false, cursor: null },
    },
    {
      match: (request) =>
        request.method === "GET" && new URL(request.url).pathname === `/apps/${appId}/envs`,
      status: 200,
      body: { items: envItemsFor(appId), readLimit: 200, readTruncated: false, cursor: null },
    },
    {
      match: (request) =>
        request.method === "GET" && new URL(request.url).pathname === "/apps/app_flag/envs",
      status: 200,
      body: {
        items: envItemsFor("app_flag"),
        readLimit: 200,
        readTruncated: false,
        cursor: null,
      },
    },
  ];
}

/**
 * Stub for Flag ID-then-key resolution via `flags_list`. Compose after
 * `scopeResolutionStubs` and before the operation under test — never embed this
 * inside App/Env scope stubs, so `flags list` tests stay explicit.
 */
export function flagsListStub(options?: {
  readonly appId?: string;
  readonly flags?: ReadonlyArray<{
    readonly id: string;
    readonly key: string;
    readonly name?: string;
  }>;
  readonly readTruncated?: boolean;
  readonly readLimit?: number;
}): FakeResponse {
  const appId = options?.appId ?? "app_1";
  const flags = options?.flags ?? [
    {
      id: "flag_checkout_banner",
      key: "checkout-banner",
      name: "Checkout banner",
    },
  ];
  return {
    match: (request) =>
      request.method === "GET" && new URL(request.url).pathname === `/apps/${appId}/flags`,
    status: 200,
    body: {
      items: flags.map((flag) => ({
        id: flag.id,
        appId,
        key: flag.key,
        name: flag.name ?? flag.key,
        schema: null,
        variants: [{ id: "var_on", name: "on", value: true }],
        defaultVariantId: "var_on",
        createdAt: scopeStamp,
        updatedAt: scopeStamp,
      })),
      readTruncated: options?.readTruncated ?? false,
      readLimit: options?.readLimit ?? 200,
      cursor: null,
    },
  };
}
