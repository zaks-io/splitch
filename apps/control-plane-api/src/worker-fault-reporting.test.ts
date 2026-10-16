import { createRepository } from "@splitch/db";
import { __setSentryModuleForTests } from "@splitch/observability/sentry-module";
import {
  createWorkerFaultReporter,
  createWorkerObservability,
  serializeFault,
} from "@splitch/observability/worker";
import { createRegistrar, PUBLIC_PRINCIPAL } from "@splitch/worker-runtime";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { type ApprovalArchiveStore, runApprovalRequestArchival } from "./approval-archive";
import type { RequestRow } from "./approval-model";
import { controlPlaneRoute } from "./routes";

afterEach(() => {
  __setSentryModuleForTests(undefined);
  vi.restoreAllMocks();
});

it("bounds a 100 KB repository query failure and withholds a native parser excerpt from every sink", async () => {
  const captureMessage = vi.fn();
  const addBreadcrumb = vi.fn();
  __setSentryModuleForTests({ captureMessage, addBreadcrumb } as unknown as Parameters<
    typeof __setSentryModuleForTests
  >[0]);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const prefix = "dbcanary";
  const canary = prefix + "x".repeat(100_000);
  let parserFailure: unknown;
  try {
    JSON.parse(canary);
  } catch (error) {
    parserFailure = error;
  }
  expect(parserFailure).toBeInstanceOf(SyntaxError);
  expect((parserFailure as SyntaxError).message).toContain(prefix);
  const statement = {
    bind: vi.fn().mockReturnThis(),
    raw: vi.fn().mockRejectedValue(parserFailure),
  };
  const repo = createRepository({ prepare: vi.fn(() => statement) } as unknown as D1Database);
  const failure = await repo.identity
    .completeAppCreate("large-query-id-canary", canary)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  const fault = serializeFault(failure);
  expect(fault).toContain('update "apps" set "create_response" = ?');
  expect(fault).toContain("SyntaxError: [message withheld]");
  expect(new TextEncoder().encode(fault).byteLength).toBeLessThanOrEqual(8192);
  const pending: Promise<unknown>[] = [];
  const observability = createWorkerObservability(
    { SENTRY_DSN: "https://example@sentry.io/1" },
    {
      surface: "control-plane-api",
      waitUntil: (promise) => pending.push(promise),
    },
  );
  expect(() =>
    observability.onError?.({
      requestId: "req-large-query",
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
      cause: failure,
    }),
  ).not.toThrow();
  observability.onError?.({
    requestId: "req-large-query-breadcrumb",
    code: "BAD_REQUEST",
    status: 400,
    cause: failure,
  });
  await Promise.all(pending);
  expect(captureMessage).toHaveBeenCalledOnce();
  expect(addBreadcrumb).toHaveBeenCalledOnce();
  expect(consoleError).toHaveBeenCalled();
  expect(
    JSON.stringify([captureMessage.mock.calls, addBreadcrumb.mock.calls, consoleError.mock.calls]),
  ).not.toContain(prefix);
  expect(
    JSON.stringify([captureMessage.mock.calls, addBreadcrumb.mock.calls, consoleError.mock.calls]),
  ).not.toContain("large-query-id-canary");
});

it("reports real approval archival query failures without bound parameters in Sentry or Workers Logs", async () => {
  const captureMessage = vi.fn();
  __setSentryModuleForTests({ captureMessage } as unknown as Parameters<
    typeof __setSentryModuleForTests
  >[0]);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const statement = {
    bind: vi.fn().mockReturnThis(),
    raw: vi.fn().mockRejectedValue(new Error("D1_ERROR: archive read failed")),
  };
  const repo = createRepository({ prepare: vi.fn(() => statement) } as unknown as D1Database);
  vi.spyOn(repo.approvals, "listArchiveCandidates").mockResolvedValue([
    {
      id: "apr_archive_fault",
      appId: "archive-bound-canary",
      status: "declined",
      resolvedAt: "2026-01-01T00:00:00.000Z",
    } as RequestRow,
  ]);
  const failure = await runApprovalRequestArchival({
    repo,
    store: {} as ApprovalArchiveStore,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).message).not.toContain("archive-bound-canary");
  expect(statement.raw).toHaveBeenCalledOnce();
  const pending: Promise<unknown>[] = [];
  createWorkerFaultReporter(
    { SENTRY_DSN: "https://example@sentry.io/1" },
    {
      surface: "control-plane-api",
      waitUntil: (promise) => pending.push(promise),
    },
  )("approval_request_archive_failed", { fault: serializeFault(failure) });
  await Promise.all(pending);
  const context = captureMessage.mock.calls[0]?.[1];
  expect(context.extra.fault).toContain("Approval Request");
  expect(context.extra.fault).toContain('from "approval_reviews"');
  expect(context.extra.fault).toContain("D1_ERROR: archive read failed");
  expect(consoleError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "approval_request_archive_failed",
      fault: expect.stringContaining("D1_ERROR: archive read failed"),
    }),
  );
  const emitted = JSON.stringify([context, consoleError.mock.calls]);
  expect(emitted).not.toContain("archive-bound-canary");
  expect(emitted).not.toContain("params:");
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
