import { describe, expect, it, vi } from "vitest";
import { parseControlPanelOperation } from "./control-panel-operation";
import { createControlPlaneSdk, type FlagsClient } from "./index";

/**
 * The Panel's Flags client is the source of truth for which Flag method+path
 * pairs the binding must accept. The hand-written OPERATION_ROUTES table cannot
 * see a route the client emits that has no operation — that was the dead
 * Flag-detail failure mode. Drive the client, capture every request, and assert
 * each one parses.
 *
 * The driven set must cover every `FlagsClient` method name: a new method on the
 * client that the Panel starts calling must fail this test until someone drives
 * it (and, if needed, adds the matching binding operation).
 */

const APP = "app_checkout";
const ENV = "env_dev";
const FLAG_ID = "flag_checkout";
const FLAG_KEY = "new-checkout";
const VARIANT_NAME = "disabled";

/** Flag methods the Control Panel binding currently claims. */
const BINDING_METHODS = new Set<keyof FlagsClient>([
  "list",
  "get",
  "create",
  "getConfig",
  "updateConfig",
  "replaceTargetingRules",
  "promote",
]);

const flagDefinition = {
  id: FLAG_ID,
  appId: APP,
  key: FLAG_KEY,
  name: "New Checkout",
  schema: { type: "boolean" as const },
  variants: [
    { id: "var_disabled", name: "disabled", value: false },
    { id: "var_enabled", name: "enabled", value: true },
  ],
  defaultVariantId: "var_disabled",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const flagConfig = {
  flagId: FLAG_ID,
  environmentId: ENV,
  version: 1,
  enabled: true,
  availableVariantNames: ["disabled", "enabled"],
  targetingRules: [],
  rollout: null,
  experiment: null,
};

describe("Panel Flags client → control-panel operation coverage", () => {
  it("parses every method+path the Panel Flags client emits", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      requests.push(request);
      return stubFlagsResponse(request);
    });
    const flags = createControlPlaneSdk({
      baseUrl: "https://control-plane.internal",
      fetch: fetcher,
    }).flags;

    const driven = new Set<string>();
    const bindingRequests: Request[] = [];

    async function drive(name: keyof FlagsClient, call: () => Promise<unknown>): Promise<void> {
      driven.add(name);
      const before = requests.length;
      await call();
      if (BINDING_METHODS.has(name)) {
        bindingRequests.push(...requests.slice(before));
      }
    }

    await drive("list", () => flags.list({ appId: APP }));
    await drive("get", () => flags.get({ appId: APP, flagId: FLAG_KEY, by: "key" }));
    await drive("create", () =>
      flags.create({
        appId: APP,
        idempotency_key: "idem-panel-flags-client-ops",
        key: FLAG_KEY,
        name: "New Checkout",
        schema: { type: "boolean" },
        variants: [
          { name: "disabled", value: false, isDefault: true },
          { name: "enabled", value: true, isDefault: false },
        ],
      }),
    );
    await drive("update", () =>
      flags.update({
        appId: APP,
        flagId: FLAG_ID,
        name: "Renamed",
      }),
    );
    await drive("delete", () =>
      flags.delete({ appId: APP, flagId: FLAG_ID }, { idempotencyKey: "idem-panel-delete" }),
    );
    await drive("createVariant", () =>
      flags.createVariant({
        appId: APP,
        flagId: FLAG_ID,
        name: "beta",
        value: false,
        idempotency_key: "idem-panel-variant-create",
      }),
    );
    await drive("updateVariant", () =>
      flags.updateVariant({
        appId: APP,
        flagId: FLAG_ID,
        variantName: VARIANT_NAME,
        name: "off",
        idempotency_key: "idem-panel-variant-update",
      }),
    );
    await drive("deleteVariant", () =>
      flags.deleteVariant(
        { appId: APP, flagId: FLAG_ID, variantName: VARIANT_NAME },
        { idempotencyKey: "idem-panel-variant-delete" },
      ),
    );
    await drive("getConfig", () =>
      flags.getConfig({ appId: APP, environmentId: ENV, flagId: FLAG_ID }),
    );
    await drive("updateConfig", () =>
      flags.updateConfig({
        appId: APP,
        environmentId: ENV,
        flagId: FLAG_ID,
        enabled: true,
        idempotency_key: "idem-panel-update-config",
      }),
    );
    await drive("replaceTargetingRules", () =>
      flags.replaceTargetingRules({
        appId: APP,
        environmentId: ENV,
        flagId: FLAG_ID,
        targetingRules: [],
        idempotency_key: "idem-panel-targeting",
      }),
    );
    await drive("promote", () =>
      flags.promote({
        appId: APP,
        targetEnvironmentId: ENV,
        flagId: FLAG_ID,
        fromEnvironmentId: "env_staging",
        select: { enabled: true },
        idempotency_key: "idem-panel-promote",
      }),
    );

    // A new FlagsClient method the Panel starts calling must fail here until
    // someone drives it — otherwise this suite stays green while the Panel is
    // dead again (the round-6 failure mode).
    expect([...Object.keys(flags)].sort()).toEqual([...driven].sort());

    expect(bindingRequests.length).toBeGreaterThan(0);
    for (const request of bindingRequests) {
      const url = new URL(request.url);
      const operation = parseControlPanelOperation(
        request.method,
        url.pathname,
        ENV,
        url.searchParams,
      );
      expect(
        operation,
        `${request.method} ${url.pathname}${url.search} must parse to a Control Panel operation`,
      ).not.toBeNull();
    }

    expect(
      bindingRequests.some((request) => {
        const url = new URL(request.url);
        return (
          request.method === "GET" &&
          url.pathname === `/apps/${APP}/flags/${FLAG_KEY}` &&
          url.searchParams.get("by") === "key"
        );
      }),
    ).toBe(true);
  });
});

function stubFlagsResponse(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname.endsWith("/flags")) {
    return listOrCreateFlagsResponse(request.method);
  }
  if (pathname.includes("/promote")) {
    return promoteResponse();
  }
  if (isConfigWrite(pathname, request.method)) {
    return Response.json({ config: flagConfig, approvalRequest: null });
  }
  if (pathname.includes("/config")) return Response.json(flagConfig);
  if (pathname.includes("/variants")) {
    return variantResponse(request.method);
  }
  return Response.json(flagDefinition);
}

function promoteResponse(): Response {
  return Response.json({
    config: flagConfig,
    diff: { before: { ...flagConfig, enabled: false }, after: flagConfig },
    approvalRequest: null,
  });
}

function isConfigWrite(pathname: string, method: string): boolean {
  return (
    pathname.includes("/targeting-rules") || (pathname.includes("/config") && method === "PATCH")
  );
}

function variantResponse(method: string): Response {
  if (method === "PATCH") {
    return Response.json({ flag: flagDefinition, approvalRequest: null });
  }
  return Response.json(flagDefinition);
}

function listOrCreateFlagsResponse(method: string): Response {
  return Response.json(
    method === "GET"
      ? { items: [flagDefinition], readTruncated: false, readLimit: 200 }
      : flagDefinition,
  );
}
