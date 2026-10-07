import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientSentryEnv,
  initControlPanelClientSentry,
} from "#lib/observability/panel-sentry-client";

describe("control-panel client Sentry env", () => {
  it("uses public Vite Sentry values injected into the browser bundle", () => {
    expect(
      clientSentryEnv({
        MODE: "production",
        VITE_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
        VITE_SENTRY_RELEASE: "control-panel@abc123",
        VITE_SPLITCH_PLATFORM_TARGET: "production",
      }),
    ).toEqual({
      SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      SENTRY_RELEASE: "control-panel@abc123",
      SPLITCH_PLATFORM_TARGET: "production",
    });
  });

  it("falls back to Vite mode when no hosted target is injected", () => {
    expect(
      clientSentryEnv({
        MODE: "development",
        VITE_SENTRY_DSN: "",
        VITE_SENTRY_RELEASE: "",
      }),
    ).toEqual({
      SENTRY_DSN: "",
      SENTRY_RELEASE: "",
      SPLITCH_PLATFORM_TARGET: "development",
    });
  });
});

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@sentry/react", () => ({
  init,
  tanstackRouterBrowserTracingIntegration: () => ({ name: "BrowserTracing" }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("keeps the privacy options when the browser tracing integration is installed", async () => {
  vi.stubGlobal("window", {});
  vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
  await initControlPanelClientSentry({} as never);
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
  expect(options.integrations.map((integration: { name: string }) => integration.name)).toEqual([
    "SplitchPrivacy",
    "BrowserTracing",
  ]);
  expect(
    options.beforeSendSpan({
      name: "GET https://upstream.test?cohort=private",
      attributes: { "sentry.op": "http.client" },
    }).name,
  ).toBe("[Redacted]");
});
