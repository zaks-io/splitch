import { afterEach, describe, expect, it, vi } from "vitest";
import { __setSentryModuleForTests } from "./sentry-module.js";
import { activeTraceId, workerSentryOptions } from "./worker.js";

type SentryCloudflare = typeof import("@sentry/cloudflare");

function mockSentryModule(): SentryCloudflare {
  return {
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    withSentry: (_opts: unknown, handler: unknown) => handler,
  } as unknown as SentryCloudflare;
}

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
      enableRpcTracePropagation: true,
      tracesSampleRate: 1,
    });
  });

  it("drops Sentry's Console integration so fault rows are not double-sent", () => {
    const options = workerSentryOptions(
      { SENTRY_DSN: "https://example@sentry.io/1" },
      { surface: "auth-api" },
      mockSentryModule(),
    );

    // emitToWorkersLogs console.errors the fault row, and captureMessage sends
    // the same row as `extra` immediately after. Left enabled, consoleIntegration
    // would attach the console line as a breadcrumb on that very event.
    const kept = options.integrations([{ name: "Console" }, { name: "Dedupe" }]);

    expect(kept.map((i) => i.name)).toEqual(["Dedupe"]);
  });

  /**
   * Every Worker here accepts unauthenticated requests on at least one route, and
   * `sentry-trace` is an ordinary request header. Left on the default, any caller
   * could name the trace id its call joins and write spans into a trace it does
   * not own. `strictTraceContinuation` keeps continuation to our own org and
   * starts a fresh trace for anyone else's.
   */
  it("refuses to continue a trace from another Sentry org", () => {
    expect(
      workerSentryOptions(
        { SENTRY_DSN: "https://example@sentry.io/1" },
        { surface: "mcp-server" },
        mockSentryModule(),
      ).strictTraceContinuation,
    ).toBe(true);
  });

  it("scrubs span payloads on their way out", () => {
    const options = workerSentryOptions(
      { SENTRY_DSN: "https://example@sentry.io/1" },
      { surface: "mcp-server" },
      mockSentryModule(),
    );

    const scrubbed = options.beforeSendSpan?.({
      op: "mcp.server",
      description: "tools/call flags_list",
      data: { "mcp.tool.name": "flags_list", "mcp.request.argument.email": "leak@evil.com" },
    } as never) as unknown as { op: string; data: Record<string, unknown> };

    expect(scrubbed.op).toBe("mcp.server");
    expect(scrubbed.data["mcp.tool.name"]).toBe("flags_list");
    expect(JSON.stringify(scrubbed).includes("leak@evil.com")).toBe(false);
  });
  /**
   * `beforeSendSpan` runs first and covers `contexts.trace` and `spans`; the rest
   * of the transaction envelope has no hook of its own, and `beforeSend` fires
   * for error events only.
   */
  it("scrubs the transaction envelope the span hook never reaches", () => {
    const options = workerSentryOptions(
      { SENTRY_DSN: "https://example@sentry.io/1" },
      { surface: "mcp-server" },
      mockSentryModule(),
    );

    const scrubbed = options.beforeSendTransaction?.({
      type: "transaction",
      contexts: { trace: { trace_id: "aabbccddeeff00112233445566778899" } },
      request: { headers: { authorization: "Bearer leak-token" } },
    } as never) as unknown as { contexts: { trace: { trace_id: string } } };

    expect(scrubbed.contexts.trace.trace_id).toBe("aabbccddeeff00112233445566778899");
    expect(JSON.stringify(scrubbed).includes("leak-token")).toBe(false);
  });
});

describe("activeTraceId", () => {
  afterEach(() => {
    __setSentryModuleForTests(undefined);
  });

  it("is undefined with no DSN configured, so nothing loads Sentry", async () => {
    await expect(activeTraceId({})).resolves.toBeUndefined();
  });

  it("returns the trace id of the active span", async () => {
    __setSentryModuleForTests({
      ...mockSentryModule(),
      getActiveSpan: () => ({}) as never,
      spanToJSON: () => ({ trace_id: "aabbccddeeff00112233445566778899" }) as never,
    } as SentryCloudflare);

    await expect(activeTraceId({ SENTRY_DSN: "https://example@sentry.io/1" })).resolves.toBe(
      "aabbccddeeff00112233445566778899",
    );
  });

  it("returns undefined when no span is active rather than inventing a reference", async () => {
    __setSentryModuleForTests({
      ...mockSentryModule(),
      getActiveSpan: () => undefined,
    } as unknown as SentryCloudflare);

    await expect(
      activeTraceId({ SENTRY_DSN: "https://example@sentry.io/1" }),
    ).resolves.toBeUndefined();
  });
});
