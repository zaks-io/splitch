import {
  Client,
  type ClientOptions,
  createTransport,
  type Event,
  featureFlagsIntegration,
  getCurrentScope,
  setCurrentClient,
} from "@sentry/core";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkResolutionDetails } from "../resolution";
import { sentryResolutionReporter } from "./index";

/**
 * These run against a REAL `@sentry/core` client with the REAL
 * `featureFlagsIntegration()`, because the whole point of the reporter is what
 * survives Sentry's own buffer: `addFeatureFlag` silently drops any non-boolean
 * value, so a hand-rolled fake integration would happily "record" a string and
 * prove nothing.
 */

class TestClient extends Client {
  eventFromException(exception: unknown): PromiseLike<Event> {
    return Promise.resolve({ exception: { values: [{ value: String(exception) }] } });
  }
  eventFromMessage(message: string): PromiseLike<Event> {
    return Promise.resolve({ message });
  }
}

/**
 * A client only wires up its integrations when it has a DSN, so one is required
 * even though the stub transport sends nothing anywhere.
 */
function installSentry(integrations = [featureFlagsIntegration()]): void {
  const options = {
    dsn: "https://public@o0.ingest.sentry.io/1",
    integrations,
    transport: () => createTransport({ recordDroppedEvent: () => {} }, () => Promise.resolve({})),
    stackParser: () => [],
  } as unknown as ClientOptions;
  const client = new TestClient(options);
  setCurrentClient(client);
  client.init();
}

/** What Sentry would actually attach to an error event right now. */
function bufferedFlags(): Array<{ flag: string; result: boolean }> {
  const flags = getCurrentScope().getScopeData().contexts.flags;
  return (flags?.values ?? []) as Array<{ flag: string; result: boolean }>;
}

function details(overrides: Partial<SdkResolutionDetails> = {}): SdkResolutionDetails {
  return { value: true, variantName: null, reason: "TARGETING_MATCH", ...overrides };
}

afterEach(() => {
  getCurrentScope().clear();
});

describe("sentryResolutionReporter", () => {
  it("records a boolean resolution under the flag key", () => {
    installSentry();
    sentryResolutionReporter()("checkout-v2", details({ value: false }));
    expect(bufferedFlags()).toEqual([{ flag: "checkout-v2", result: false }]);
  });

  it("encodes a multivariate arm as `flag:variant` = true", () => {
    installSentry();
    sentryResolutionReporter()(
      "checkout-flow",
      details({ value: "blue", variantName: "treatment" }),
    );
    // Sentry's buffer is boolean-only, so the arm has to live in the name or the
    // whole evaluation disappears inside Sentry.
    expect(bufferedFlags()).toEqual([{ flag: "checkout-flow:treatment", result: true }]);
  });

  it("keeps two arms of the same flag as distinct entries", () => {
    installSentry();
    const report = sentryResolutionReporter();
    report("theme", details({ value: "dark", variantName: "dark" }));
    report("theme", details({ value: "light", variantName: "light" }));
    expect(bufferedFlags()).toEqual([
      { flag: "theme:dark", result: true },
      { flag: "theme:light", result: true },
    ]);
  });

  it("records nothing when the default was served because evaluation failed", () => {
    installSentry();
    const logger = recordingLogger();
    sentryResolutionReporter({ logger })(
      "checkout-v2",
      details({ value: true, reason: "ERROR", errorCode: "SDK_TRANSPORT_TIMEOUT" }),
    );
    // Reporting the caller's default as a resolution is the disguised default
    // ADR-0036 forbids; the captured exception carries the real story.
    expect(bufferedFlags()).toEqual([]);
    expect(logger.errors).toEqual([]);
  });

  it("reports, rather than silently drops, a non-boolean resolution with no variant", () => {
    installSentry();
    const logger = recordingLogger();
    sentryResolutionReporter({ logger })(
      "pricing",
      details({ value: { tier: "a" }, reason: "DEFAULT" }),
    );
    expect(bufferedFlags()).toEqual([]);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.detail).toMatchObject({ flagKey: "pricing", reason: "DEFAULT" });
  });

  it("reports an unrecordable flag once, however many times it resolves", () => {
    installSentry();
    const logger = recordingLogger();
    const report = sentryResolutionReporter({ logger });
    for (let i = 0; i < 5; i += 1) {
      report("pricing", details({ value: { tier: "a" }, reason: "DEFAULT" }));
    }
    report("shipping", details({ value: { tier: "b" }, reason: "DEFAULT" }));
    // Bounded by distinct flag key: a busy page must not flood the console, and
    // a second unrecordable flag must not be hidden by the first.
    expect(logger.errors.map((entry) => entry.message)).toHaveLength(2);
  });

  it("fails loud when the host app never installed the FeatureFlags integration", () => {
    installSentry([]);
    const logger = recordingLogger();
    sentryResolutionReporter({ logger })("checkout-v2", details());
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("no Sentry FeatureFlags integration");
  });
});

function recordingLogger(): {
  errors: Array<{ message: string; detail: unknown }>;
  error(message: string, detail: unknown): void;
  debug(): void;
} {
  const errors: Array<{ message: string; detail: unknown }> = [];
  return {
    errors,
    error(message, detail) {
      errors.push({ message, detail });
    },
    debug() {},
  };
}
