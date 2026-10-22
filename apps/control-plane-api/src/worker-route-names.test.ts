import { controlPlaneRoute } from "./routes";
import { __setSentryModuleForTests } from "@splitch/observability/sentry-module";
import {
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
} from "@splitch/observability/worker";
import { createRegistrar } from "@splitch/worker-runtime";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => __setSentryModuleForTests(undefined));

it.each(["control-plane-api", "evaluation-api", "analysis-api"] as const)(
  "names both %s roots from the matched template, never path parameter values",
  async (surface) => {
    const native = { updateName: vi.fn(), setAttribute: vi.fn() };
    const root = { setAttribute: vi.fn() };
    const active = {};
    const updateSpanName = vi.fn();
    const getRootSpan = vi.fn(() => root);
    __setSentryModuleForTests({
      getActiveSpan: () => active,
      getRootSpan,
      updateSpanName,
      addBreadcrumb: vi.fn(),
    } as unknown as Parameters<typeof __setSentryModuleForTests>[0]);
    const observability = createWorkerObservability(
      { SENTRY_DSN: "https://example@sentry.invalid/1" },
      workerObservabilityWithWaitUntil(surface, {
        waitUntil() {},
        tracing: { getActiveSpan: () => native } as unknown as ExecutionContext["tracing"],
      }),
    );
    const app = new Hono();
    const registrar = createRegistrar({
      authResolvers: {
        "control-plane-token": () => ({
          ok: true,
          principal: {
            kind: "control-plane-token",
            id: "actor",
            orgId: "private-org-canary",
            appId: null,
            environmentId: null,
            scopes: [],
            authDoor: "id_jag",
          },
        }),
      },
      observability,
    });
    const contract = {
      ...controlPlaneRoute("apps_list"),
      scopes: [],
      rateLimit: "none" as const,
    };
    registrar.mount(app, contract, () => Response.json({ items: [] }));
    const unmatched = await app.request("/unmatched/private-canary");
    expect(unmatched.status).toBe(404);
    expect(native.updateName).not.toHaveBeenCalled();
    const response = await app.request("/orgs/private-org-canary/apps");
    expect(response.status).toBe(200);
    expect(native.updateName).toHaveBeenCalledExactlyOnceWith("GET /orgs/:orgId/apps");
    expect(native.setAttribute).toHaveBeenCalledWith("http.route", contract.path);
    expect(getRootSpan).toHaveBeenCalledWith(active);
    expect(updateSpanName).toHaveBeenCalledExactlyOnceWith(root, "GET /orgs/:orgId/apps");
    expect(root.setAttribute).toHaveBeenCalledWith("http.route", contract.path);
    expect(JSON.stringify(updateSpanName.mock.calls)).not.toContain("private-org-canary");
  },
);

it.each(["auth-api", "event-ingest-api", "mcp-server"] as const)(
  "keeps concrete paths from %s out of span names",
  (surface) => {
    const updateName = vi.fn();
    createWorkerObservability(
      {},
      {
        surface,
        tracing: {
          getActiveSpan: () => ({ updateName }),
        } as unknown as ExecutionContext["tracing"],
      },
    ).onRequest?.({
      requestId: "req",
      method: "GET",
      path: "/private-canary",
    });
    expect(updateName).not.toHaveBeenCalled();
  },
);

it("names native spans without loading an SDK when none is initialized", () => {
  const updateName = vi.fn();
  createWorkerObservability(
    {},
    {
      surface: "analysis-api",
      tracing: {
        getActiveSpan: () => ({ updateName, setAttribute: vi.fn() }),
      } as unknown as ExecutionContext["tracing"],
    },
  ).onRequest?.({
    requestId: "req",
    method: "GET",
    path: "/template/:id",
  });
  expect(updateName).toHaveBeenCalledWith("GET /template/:id");
});
