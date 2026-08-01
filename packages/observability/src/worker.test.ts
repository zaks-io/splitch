import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setSentryModuleForTests,
  createWorkerObservability,
  workerEmitter,
  workerSentryOptions,
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

describe("workerSentryOptions", () => {
  it("passes the deployed release through to Sentry", () => {
    expect(
      workerSentryOptions(
        {
          SENTRY_DSN: "https://example@sentry.io/1",
          SENTRY_RELEASE: "splitch-auth-api@abc123",
          SPLITCH_PLATFORM_TARGET: "production",
        },
        { surface: "auth-api" },
        mockSentryModule(),
      ),
    ).toMatchObject({
      environment: "production",
      release: "splitch-auth-api@abc123",
    });
  });
});
