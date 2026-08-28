import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setSentryModuleForTests } from "./sentry-module.js";
import {
  activeTraceId,
  createWorkerObservability,
  workerEmitter,
  workerObservabilityWithWaitUntil,
  workerSentryOptions,
  wrapWorkerHandler,
} from "./worker.js";

const captureMessage = vi.fn();
const addBreadcrumb = vi.fn();

type SentryCloudflare = typeof import("@sentry/cloudflare");

function mockSentryModule(): SentryCloudflare {
  return {
    captureMessage,
    addBreadcrumb,
    withSentry: (_opts: unknown, handler: unknown) => handler,
  } as unknown as SentryCloudflare;
}

async function flushSentryHooks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createWorkerObservability onError", () => {
  beforeEach(() => {
    captureMessage.mockReset();
    addBreadcrumb.mockReset();
    __setSentryModuleForTests(mockSentryModule());
  });

  afterEach(() => {
    __setSentryModuleForTests(undefined);
    vi.clearAllMocks();
  });

  it("does not emit Sentry error events for expected registrar failures", async () => {
    const observability = createWorkerObservability(
      { SENTRY_DSN: "https://example@sentry.io/1" },
      { surface: "evaluation-api" },
    );

    observability.onError?.({
      requestId: "req-validation",
      code: "VALIDATION_ERROR",
      status: 0,
    });
    await flushSentryHooks();

    expect(captureMessage).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "request_error",
        message: "VALIDATION_ERROR",
      }),
    );
  });

  it.each([
    ["FORBIDDEN", 0],
    ["UNAUTHORIZED", 0],
    ["RATE_LIMITED", 0],
    ["INSUFFICIENT_SCOPES", 0],
  ] as const)("records %s as breadcrumb only", async (code, status) => {
    const observability = createWorkerObservability(
      { SENTRY_DSN: "https://example@sentry.io/1" },
      { surface: "control-plane-api" },
    );

    observability.onError?.({ requestId: "req-domain", code, status });
    await flushSentryHooks();

    expect(captureMessage).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalled();
  });

  it("emits Sentry error events for INTERNAL_SERVER_ERROR faults", async () => {
    const observability = createWorkerObservability(
      { SENTRY_DSN: "https://example@sentry.io/1" },
      { surface: "auth-api" },
    );

    observability.onError?.({
      requestId: "req-fault",
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
    });
    await flushSentryHooks();

    expect(captureMessage).toHaveBeenCalledWith(
      "worker fault INTERNAL_SERVER_ERROR",
      expect.objectContaining({
        level: "error",
        tags: { surface: "auth-api", code: "INTERNAL_SERVER_ERROR" },
      }),
    );
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it("keeps Sentry work alive through the request execution context", async () => {
    const pending: Promise<unknown>[] = [];
    const options = workerObservabilityWithWaitUntil("auth-api", {
      waitUntil(promise) {
        pending.push(promise);
      },
    });
    const observability = createWorkerObservability(
      { SENTRY_DSN: "https://example@sentry.io/1" },
      options,
    );

    observability.onError?.({
      requestId: "req-fault",
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
    });

    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(captureMessage).toHaveBeenCalled();
  });

  /**
   * The 500 body is a fixed "unhandled runtime fault" so nothing internal leaks
   * to the caller, which leaves this the only path the thrown value has to an
   * operator. Without it every distinct fault pages as the same blank 500.
   */
  it("carries the thrown value's identity into the fault event", async () => {
    const observability = createWorkerObservability(
      { SENTRY_DSN: "https://example@sentry.io/1" },
      { surface: "analysis-api" },
    );

    observability.onError?.({
      requestId: "req-fault",
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
      cause: new Error("Network connection lost."),
    });
    await flushSentryHooks();

    const extra = captureMessage.mock.calls[0]?.[1]?.extra as { fault?: string };
    expect(extra.fault).toContain("Network connection lost.");
  });

  it("names the shape of a non-Error throw rather than reporting nothing", async () => {
    const observability = createWorkerObservability(
      { SENTRY_DSN: "https://example@sentry.io/1" },
      { surface: "analysis-api" },
    );

    observability.onError?.({
      requestId: "req-fault",
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
      cause: "bare string throw",
    });
    await flushSentryHooks();

    const extra = captureMessage.mock.calls[0]?.[1]?.extra as { fault?: string };
    expect(extra.fault).toContain("bare string throw");
  });

  it("omits the fault field when nothing was thrown", async () => {
    const observability = createWorkerObservability(
      { SENTRY_DSN: "https://example@sentry.io/1" },
      { surface: "analysis-api" },
    );

    observability.onError?.({ requestId: "req-domain", code: "FORBIDDEN", status: 0 });
    await flushSentryHooks();

    const data = addBreadcrumb.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("fault");
    // The reduction must not smuggle the raw thrown value alongside its identity.
    expect(data).not.toHaveProperty("cause");
  });

  it("skips Sentry hooks entirely when SENTRY_DSN is unset", async () => {
    const observability = createWorkerObservability({}, { surface: "mcp-server" });

    observability.onError?.({
      requestId: "req-local",
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
    });
    await flushSentryHooks();

    expect(captureMessage).not.toHaveBeenCalled();
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it("keeps Worker structured log scrubbing local", () => {
    const structuredLogEvents: Record<string, unknown>[][] = [];
    const env = {
      SPLITCH_PLATFORM_TARGET: "local",
    };
    const emitter = workerEmitter(
      env,
      {
        surface: "evaluation-api",
      },
      {
        onStructuredLogEvents: (events) => {
          structuredLogEvents.push(events);
        },
      },
    );

    emitter.log("info", "request", { requestId: "req-structured-log" });

    expect(structuredLogEvents).toHaveLength(1);
    expect(structuredLogEvents[0]?.[0]?.requestId).toBe("req-structured-log");
  });
});

/**
 * Sentry is the only sink with a DSN behind it, and local dev and the e2e fleet
 * both run without one. Workers Logs and `wrangler tail` read console output, so
 * this is what makes a blank 500 diagnosable exactly where it was not.
 */
describe("createWorkerObservability without a Sentry DSN", () => {
  it("writes the fault to Workers Logs when SENTRY_DSN is unset", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const observability = createWorkerObservability({}, { surface: "mcp-server" });

    observability.onError?.({
      requestId: "req-local",
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
      cause: new Error("Network connection lost."),
    });

    const row = consoleError.mock.calls[0]?.[0] as { message?: string; fault?: string };
    expect(row.message).toBe("request_fault");
    expect(row.fault).toContain("Network connection lost.");
    consoleError.mockRestore();
  });

  it("keeps caller-driven rows out of Workers Logs", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const observability = createWorkerObservability({}, { surface: "evaluation-api" });

    observability.onRequest?.({ requestId: "req-1", method: "GET", path: "/flags/:flagKey" });
    observability.onError?.({ requestId: "req-2", code: "UNAUTHORIZED", status: 401 });
    observability.onError?.({ requestId: "req-3", code: "RATE_LIMITED", status: 429 });

    // Workers Logs bills per event, and the volume of both of these is chosen by
    // the caller: one info row per request on the evaluation hot path, and one
    // warn row per rejection under a credential-stuffing or rate-limited flood.
    // Neither tells an operator anything the caller was not already told.
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    for (const spy of [consoleError, consoleWarn, consoleLog]) spy.mockRestore();
  });
});

describe("wrapWorkerHandler", () => {
  it("routes queue deliveries through the Sentry wrapper", async () => {
    const sentryQueue = vi.fn();
    __setSentryModuleForTests({
      ...mockSentryModule(),
      withSentry: (_options, handler) => ({ ...handler, queue: sentryQueue }),
    } as SentryCloudflare);
    const rawQueue = vi.fn();
    const wrapped = wrapWorkerHandler(
      {
        fetch: async () => new Response("ok"),
        queue: rawQueue,
      },
      { surface: "event-ingest-api" },
    );

    await wrapped.queue?.(
      {
        messages: [],
        queue: "metric-events",
        metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
        ackAll: vi.fn(),
        retryAll: vi.fn(),
      },
      { SENTRY_DSN: "https://example@sentry.io/1" },
      {} as ExecutionContext,
    );

    expect(sentryQueue).toHaveBeenCalledOnce();
    expect(rawQueue).not.toHaveBeenCalled();
    __setSentryModuleForTests(undefined);
  });
});
