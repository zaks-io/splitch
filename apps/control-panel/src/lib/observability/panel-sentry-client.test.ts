import { describe, expect, it } from "vitest";
import { clientSentryEnv } from "#lib/observability/panel-sentry-client";

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
