import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setSentryModuleForTests, createWorkerObservability } from "./worker.js";

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

  it("schedules Axiom flush through waitUntil when configured", () => {
    const scheduled: Promise<unknown>[] = [];
    const observability = createWorkerObservability(
      {
        AXIOM_TOKEN: "xaat-test-token",
        AXIOM_DATASET: "splitch-logs",
      },
      {
        surface: "evaluation-api",
        scheduleBackgroundWork: (work) => {
          scheduled.push(work);
        },
      },
    );

    observability.onRequest?.({
      requestId: "req-axiom",
      method: "GET",
      path: "/health",
    });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toBeInstanceOf(Promise);
  });
});
