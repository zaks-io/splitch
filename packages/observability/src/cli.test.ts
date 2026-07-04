import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const captureException = vi.fn();
const flush = vi.fn().mockResolvedValue(true);
const close = vi.fn().mockResolvedValue(true);

vi.mock("@sentry/node", () => ({
  init: (...args: unknown[]) => init(...args),
  captureException: (...args: unknown[]) => captureException(...args),
  flush: (...args: unknown[]) => flush(...args),
  close: (...args: unknown[]) => close(...args),
}));

import {
  __resetCliObservabilityForTests,
  initCliObservability,
  shutdownCliObservability,
} from "./cli.js";

const CLI_ENV = {
  SENTRY_DSN: "https://example@o0.ingest.sentry.io/0",
  SPLITCH_PLATFORM_TARGET: "local",
};

describe("initCliObservability", () => {
  beforeEach(() => {
    __resetCliObservabilityForTests();
    init.mockReset();
    captureException.mockReset();
    flush.mockClear();
    close.mockClear();
  });

  afterEach(() => {
    __resetCliObservabilityForTests();
  });

  it("routes captureException through Sentry when SENTRY_DSN is configured", () => {
    const emitter = initCliObservability(CLI_ENV);
    const error = new Error("cli health failed");

    emitter.captureException(error, { command: "health", endpoint: "http://localhost:8787" });

    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0]?.[0]).toMatchObject({
      integrations: expect.any(Function),
    });
    const integrations = init.mock.calls[0]?.[0] as {
      integrations: (defaults: Array<{ name: string }>) => Array<{ name: string }>;
    };
    expect(
      integrations.integrations([{ name: "OnUnhandledRejection" }, { name: "InboundFilters" }]),
    ).toEqual([{ name: "InboundFilters" }]);
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

  it("flushes and closes Sentry when shutdown is called after init", async () => {
    initCliObservability(CLI_ENV);

    await shutdownCliObservability(1500);

    expect(flush).toHaveBeenCalledWith(1500);
    expect(close).toHaveBeenCalledWith(1500);
  });

  it("does not flush or close Sentry when shutdown runs without init", async () => {
    await shutdownCliObservability();

    expect(flush).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
