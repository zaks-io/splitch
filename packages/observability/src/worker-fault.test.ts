import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setSentryModuleForTests } from "./sentry-module.js";
import { createWorkerFaultReporter, createWorkerObservability, serializeFault } from "./worker.js";

const captureMessage = vi.fn();

describe("Worker fault reports", () => {
  beforeEach(() => {
    captureMessage.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    __setSentryModuleForTests({ captureMessage } as unknown as typeof import("@sentry/cloudflare"));
  });

  afterEach(() => {
    __setSentryModuleForTests(undefined);
    vi.restoreAllMocks();
  });

  it("groups by surface and code, independently of the shared capture stack", async () => {
    const pending: Promise<unknown>[] = [];
    const env = { SENTRY_DSN: "https://example@sentry.io/1" };
    const options = {
      surface: "control-plane-api" as const,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    };
    const report = createWorkerFaultReporter(env, options);
    report("cloudflare_push_dispatch_failed", {});
    report("sentry_webhook_dispatch_failed", {});
    report("cloudflare_push_dispatch_failed", { requestId: "another-request", code: "unrelated" });
    createWorkerFaultReporter(env, { ...options, surface: "analysis-api" })(
      "cloudflare_push_dispatch_failed",
      {},
    );
    await Promise.all(pending);

    expect(captureMessage.mock.calls.map(([, context]) => context.fingerprint)).toEqual([
      ["worker-fault", "control-plane-api", "cloudflare_push_dispatch_failed"],
      ["worker-fault", "control-plane-api", "sentry_webhook_dispatch_failed"],
      ["worker-fault", "control-plane-api", "cloudflare_push_dispatch_failed"],
      ["worker-fault", "analysis-api", "cloudflare_push_dispatch_failed"],
    ]);
  });

  it.each(["request", "side-channel"])(
    "reports SQL and D1 causes safely through %s faults",
    async (path) => {
      const query = 'update "apps" set "create_response" = ? where "id" = ?';
      const params = ["bound-canary-line-one\n    at bound-canary-line-two", "bound-app-canary"];
      const d1Cause = new Error("D1_ERROR: internal error", {
        cause: new Error("database connection interrupted"),
      });
      const error = new DrizzleQueryError(query, params, d1Cause);
      // Confirm this fixture exercises the parameter-bearing driver message and stack.
      expect(error.message).toContain(params[0]);
      expect(error.stack).toContain(params[1]);

      const pending: Promise<unknown>[] = [];
      const env = { SENTRY_DSN: "https://example@sentry.io/1" };
      const options = {
        surface: "control-plane-api" as const,
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      };
      const cause = new Error("app create failed", { cause: error });
      if (path === "request") {
        createWorkerObservability(env, options).onError?.({
          requestId: "req-query-fault",
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          cause,
        });
      } else {
        createWorkerFaultReporter(env, options)("INTERNAL_SERVER_ERROR", {
          fault: serializeFault(cause),
        });
      }
      await Promise.all(pending);

      const context = captureMessage.mock.calls[0]?.[1];
      expect(context.fingerprint).toEqual([
        "worker-fault",
        "control-plane-api",
        "INTERNAL_SERVER_ERROR",
      ]);
      expect(context.extra.fault).toContain(query);
      expect(context.extra.fault).toContain("app create failed");
      expect(context.extra.fault).toContain("D1_ERROR: internal error");
      expect(context.extra.fault).toContain("Error: [message withheld]");
      expect(context.extra.fault).not.toContain("database connection interrupted");
      expect(context.extra.fault).toContain(d1Cause.stack);
      expect(context.extra.fault).toContain("worker-fault.test.ts");
      for (const canary of [...params, "bound-canary-line-one", "bound-canary-line-two"]) {
        expect(JSON.stringify(context)).not.toContain(canary);
        expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(canary);
      }
      expect(context.extra.fault).not.toContain("params:");
      expect(context.extra).not.toHaveProperty("cause");
    },
  );
});
