import { createRepository } from "@splitch/db";
import { __setSentryModuleForTests } from "@splitch/observability/sentry-module";
import { createWorkerObservability } from "@splitch/observability/worker";
import { createRegistrar, PUBLIC_PRINCIPAL } from "@splitch/worker-runtime";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { controlPlaneRoute } from "./routes";

afterEach(() => {
  __setSentryModuleForTests(undefined);
  vi.restoreAllMocks();
});

it("keeps a failed App completion opaque to HTTP while reporting SQL and its D1 cause", async () => {
  const captureMessage = vi.fn();
  __setSentryModuleForTests({ captureMessage, addBreadcrumb: vi.fn() } as unknown as Parameters<
    typeof __setSentryModuleForTests
  >[0]);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const databaseCause = new Error("D1_ERROR: internal error");
  const statement = {
    bind: vi.fn().mockReturnThis(),
    raw: vi.fn().mockRejectedValue(databaseCause),
  };
  const database = { prepare: vi.fn(() => statement) } as unknown as D1Database;
  const repo = createRepository(database);
  const pending: Promise<unknown>[] = [];
  const observability = createWorkerObservability(
    { SENTRY_DSN: "https://example@sentry.io/1" },
    {
      surface: "control-plane-api",
      waitUntil: (promise) => pending.push(promise),
    },
  );
  const app = new Hono();
  const registrar = createRegistrar({
    authResolvers: {
      "control-plane-token": () => ({
        ok: true,
        principal: {
          ...PUBLIC_PRINCIPAL,
          kind: "control-plane-token",
          id: "operator_canary",
          orgId: "org_canary",
          authDoor: "id_jag",
        },
      }),
    },
    rateLimiter: () => ({ limited: false }),
    observability,
  });
  // Exercise the real registrar and repository with only the external auth and
  // D1 boundaries substituted, including Drizzle's own query-error wrapping.
  registrar.mount(app, controlPlaneRoute("apps_list"), async () => {
    await repo.identity.completeAppCreate("app-bound-canary", "create-response-bound-canary");
    return Response.json({ items: [] });
  });

  const response = await app.request("/orgs/org_canary/apps");
  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body).toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
    message: "unhandled runtime fault",
  });
  await Promise.all(pending);

  expect(statement.raw).toHaveBeenCalledOnce();
  const context = captureMessage.mock.calls[0]?.[1];
  expect(context.fingerprint).toEqual([
    "worker-fault",
    "control-plane-api",
    "INTERNAL_SERVER_ERROR",
  ]);
  expect(context.extra.fault).toContain('update "apps" set "create_response" = ?');
  expect(context.extra.fault).toContain(databaseCause.stack);
  const emitted = JSON.stringify([context, consoleError.mock.calls, body]);
  expect(emitted).not.toContain("app-bound-canary");
  expect(emitted).not.toContain("create-response-bound-canary");
  expect(emitted).not.toContain("params:");
  expect(JSON.stringify(body)).not.toContain("D1_ERROR");
});
