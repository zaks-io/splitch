import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";
import { parseControlPanelOperation } from "./control-panel-operation";

/**
 * The Panel's Flags client is the source of truth for which Flag method+path
 * pairs the binding must accept. The hand-written OPERATION_ROUTES table cannot
 * see a route the client emits that has no operation — that was the dead
 * Flag-detail failure mode. Drive the client, capture every request, and assert
 * each one parses.
 */

const APP = "app_checkout";
const ENV = "env_dev";
const FLAG_ID = "flag_checkout";
const FLAG_KEY = "new-checkout";

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

    // The Flag surfaces the Panel actually drives through createControlPanelFlagsClient.
    await flags.list({ appId: APP });
    await flags.get({ appId: APP, flagId: FLAG_KEY, by: "key" });
    await flags.create({
      appId: APP,
      idempotency_key: "idem-panel-flags-client-ops",
      key: FLAG_KEY,
      name: "New Checkout",
      schema: { type: "boolean" },
      variants: [
        { name: "disabled", value: false, isDefault: true },
        { name: "enabled", value: true, isDefault: false },
      ],
    });
    await flags.getConfig({ appId: APP, environmentId: ENV, flagId: FLAG_ID });
    await flags.updateConfig({
      appId: APP,
      environmentId: ENV,
      flagId: FLAG_ID,
      enabled: true,
      idempotency_key: "idem-panel-update-config",
    });
    await flags.replaceTargetingRules({
      appId: APP,
      environmentId: ENV,
      flagId: FLAG_ID,
      targetingRules: [],
      idempotency_key: "idem-panel-targeting",
    });
    await flags.promote({
      appId: APP,
      targetEnvironmentId: ENV,
      flagId: FLAG_ID,
      fromEnvironmentId: "env_staging",
      select: { enabled: true },
      idempotency_key: "idem-panel-promote",
    });

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
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
      requests.some((request) => {
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
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname.endsWith("/flags")) {
    return listOrCreateFlagsResponse(request.method);
  }
  if (pathname.includes("/promote")) {
    return Response.json({
      config: flagConfig,
      diff: { before: { ...flagConfig, enabled: false }, after: flagConfig },
      approvalRequest: null,
    });
  }
  if (
    pathname.includes("/targeting-rules") ||
    (pathname.includes("/config") && request.method === "PATCH")
  ) {
    return Response.json({ config: flagConfig, approvalRequest: null });
  }
  if (pathname.includes("/config")) return Response.json(flagConfig);
  return Response.json(flagDefinition);
}

function listOrCreateFlagsResponse(method: string): Response {
  return Response.json(
    method === "GET"
      ? { items: [flagDefinition], readTruncated: false, readLimit: 200 }
      : flagDefinition,
  );
}
