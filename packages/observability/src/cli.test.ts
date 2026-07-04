import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const captureException = vi.fn();

vi.mock("@sentry/node", () => ({
  init: (...args: unknown[]) => init(...args),
  captureException: (...args: unknown[]) => captureException(...args),
}));

import { __resetCliObservabilityForTests, initCliObservability } from "./cli.js";

const CLI_ENV = {
  SENTRY_DSN: "https://example@o0.ingest.sentry.io/0",
  AXIOM_TOKEN: "xaat-test-token",
  AXIOM_DATASET: "splitch-logs",
  SPLITCH_PLATFORM_TARGET: "local",
};

describe("initCliObservability", () => {
  beforeEach(() => {
    __resetCliObservabilityForTests();
    init.mockReset();
    captureException.mockReset();
  });

  afterEach(() => {
    __resetCliObservabilityForTests();
  });

  it("routes captureException through Sentry when SENTRY_DSN is configured", () => {
    const emitter = initCliObservability(CLI_ENV);
    const error = new Error("cli health failed");

    emitter.captureException(error, { command: "health", endpoint: "http://localhost:8787" });

    expect(init).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error, {
      extra: { command: "health", endpoint: "http://localhost:8787" },
      tags: { surface: "cli" },
    });
  });

  it("does not call Sentry.captureException when SENTRY_DSN is absent", () => {
    const emitter = initCliObservability({
      SPLITCH_PLATFORM_TARGET: "local",
    });

    emitter.captureException(new Error("local only"), { command: "health" });

    expect(init).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});
