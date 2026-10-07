import { afterEach, describe, expect, it, vi } from "vitest";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@sentry/react", () => ({
  init,
  tanstackRouterBrowserTracingIntegration: () => ({ name: "BrowserTracing" }),
}));
vi.mock("@tanstack/react-router", () => ({ createRouter: () => ({}) }));
vi.mock("./routeTree.gen", () => ({ routeTree: {} }));

import { getRouter } from "./router";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  init.mockClear();
});

describe("marketing browser Sentry", () => {
  it("disables sensitive collection and scrubs streamed spans at the actual init", async () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
    await getRouter();
    expect(init).toHaveBeenCalledOnce();
    const options = init.mock.calls[0]?.[0];
    expect(options.dataCollection).toEqual({
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
    expect(options.traceLifecycle).toBe("stream");
    expect(
      options.beforeSendSpan({
        name: "GET https://upstream.test?cohort=private",
        attributes: { "sentry.op": "http.client", "url.query": "cohort=private" },
      }),
    ).toMatchObject({ name: "[Redacted]", attributes: { "url.query": "[Redacted]" } });
    expect(() => options.integrations[0].processEvent({ type: "transaction" })).toThrow(
      "Sentry transaction events are unsupported",
    );
  });
});
