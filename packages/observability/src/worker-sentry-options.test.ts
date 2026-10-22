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
      rpcTracePropagationBindings: [/.*/],
      traceLifecycle: "stream",
      tracesSampler: expect.any(Function),
      propagateTraceparent: true,
    });
  });

  it("does not sample scheduled roots even with a sampled parent", () => {
    const options = workerSentryOptions({}, { surface: "control-plane-api" }, mockSentryModule());
    const inheritOrSampleWith = vi.fn(() => 1);
    expect(
      options.tracesSampler({
        name: "scheduled",
        attributes: { "faas.trigger": "timer", "sentry.op": "function" },
        parentSampled: true,
        inheritOrSampleWith,
      }),
    ).toBe(0);
    expect(inheritOrSampleWith).not.toHaveBeenCalled();
  });

  it.each([0, 0.25, 1])("honors the inherited HTTP sampling rate %s", (rate) => {
    const options = workerSentryOptions({}, { surface: "evaluation-api" }, mockSentryModule());
    const inheritOrSampleWith = vi.fn(() => rate);
    expect(
      options.tracesSampler({
        name: "GET",
        attributes: { "sentry.op": "http.server" },
        inheritOrSampleWith,
      }),
    ).toBe(rate);
    expect(inheritOrSampleWith).toHaveBeenCalledWith(1);
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

    expect(kept.map((i) => i.name)).toEqual(["Dedupe", "SplitchPrivacy"]);
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
      name: "tools/call flags_list",
      attributes: {
        "sentry.op": "mcp.server",
        "mcp.tool.name": "flags_list",
        "mcp.request.argument.email": "leak@evil.com",
      },
    } as never) as unknown as { attributes: Record<string, unknown> };

    expect(scrubbed.attributes["sentry.op"]).toBe("mcp.server");
    expect(scrubbed.attributes["mcp.tool.name"]).toBe("flags_list");
    expect(JSON.stringify(scrubbed).includes("leak@evil.com")).toBe(false);
  });

  it("preserves templated root names while redacting the SDK http.route attribute", () => {
    const options = workerSentryOptions({}, { surface: "control-plane-api" }, mockSentryModule());
    const template = "/api/apps/:appId/flags/:flagKey/config";
    const scrubbed = options.beforeSendSpan({
      name: `POST ${template}`,
      attributes: { "sentry.op": "http.server", "http.route": template },
    } as never);

    expect(scrubbed.name).toBe(`POST ${template}`);
    expect(scrubbed.attributes["http.route"]).toBe("[Redacted]");
  });

  it.each([
    ["production", "splitch-evaluation-api"],
    ["shared-preview", "splitch-evaluation-api-shared-preview"],
  ])("attributes SDK response spans to the %s service", (target, service) => {
    const options = workerSentryOptions(
      { SENTRY_DSN: "https://example@sentry.io/1", SPLITCH_PLATFORM_TARGET: target },
      { surface: "evaluation-api" },
      mockSentryModule(),
    );
    const scrubbed = options.beforeSendSpan({
      attributes: { "resource.service.name": "customer@example.com", targetingKey: "private-id" },
    } as never);

    expect(scrubbed.attributes).toMatchObject({ "resource.service.name": service });
    expect(JSON.stringify(scrubbed)).not.toContain("customer@example.com");
    expect(JSON.stringify(scrubbed)).not.toContain("private-id");
  });
  it("rejects transaction events in the event processor that Sentry runs for every event type", () => {
    const options = workerSentryOptions({}, { surface: "mcp-server" }, mockSentryModule());
    const privacy = options
      .integrations([])
      .find((integration) => integration.name === "SplitchPrivacy");
    expect(privacy).toBeDefined();
    expect(() =>
      (privacy as ReturnType<typeof import("./emitter.js").sentryPrivacyIntegration>).processEvent({
        type: "transaction",
      }),
    ).toThrow("Sentry transaction events are unsupported");
  });

  it.each([
    "control-plane-api",
    "evaluation-api",
    "event-ingest-api",
    "analysis-api",
    "auth-api",
    "control-panel",
    "marketing",
    "mcp-server",
  ] as const)("disables automatic sensitive collection for %s", (surface) => {
    expect(workerSentryOptions({}, { surface }, mockSentryModule()).dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
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
