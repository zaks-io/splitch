import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLogger } from "../test-fixtures";
import { createSplitchBrowserClient } from "./client";
import { BROWSER_EVALUATIONS } from "./test-fixtures";

const expiredResponse = () =>
  Response.json(
    { code: "ENVIRONMENT_EXPIRED", message: "Temporary Environment has expired" },
    { status: 410 },
  );
const context = { targetingKey: "entity-1", idType: "user", attributes: {} };
const bootstrap = { context, evaluations: BROWSER_EVALUATIONS, etag: '"etag-1"' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("browser expiry is terminal", () => {
  it("does not repeat initialization after an expired response", async () => {
    const fetch = vi.fn(async () => expiredResponse());
    const logger = new FakeLogger();
    const client = createSplitchBrowserClient({ clientKey: "pk_test", context, fetch, logger });
    await expect(client.init()).rejects.toMatchObject({ code: "ENVIRONMENT_EXPIRED" });
    await expect(client.init()).rejects.toMatchObject({ code: "ENVIRONMENT_EXPIRED" });
    expect(client.evaluateDetails("new-checkout", false)).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "ENVIRONMENT_EXPIRED",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logger.errors).toHaveLength(1);
    await client.close();
  });

  it("stops revalidation and pending exposures, replaces held values, and notifies subscribers", async () => {
    const fetch = vi.fn(async () => expiredResponse());
    const logger = new FakeLogger();
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context,
      bootstrap,
      revalidateMs: 100,
      fetch,
      logger,
    });
    const listener = vi.fn();
    client.subscribe("new-checkout", listener);
    expect(client.evaluate("new-checkout", false)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(client.evaluateDetails("new-checkout", false)).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "ENVIRONMENT_EXPIRED",
    });
    await expect(client.init()).rejects.toMatchObject({ code: "ENVIRONMENT_EXPIRED" });
    await expect(client.flush()).rejects.toMatchObject({ code: "ENVIRONMENT_EXPIRED" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logger.errors).toHaveLength(1);
    await client.close();
  });

  it("also stops revalidation when Exposure redemption first discovers expiry, with no queued retry", async () => {
    const fetch = vi.fn(async () => expiredResponse());
    const logger = new FakeLogger();
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context,
      bootstrap,
      fetch,
      logger,
    });
    client.evaluate("new-checkout", false);
    await expect(client.flush()).rejects.toMatchObject({ code: "ENVIRONMENT_EXPIRED" });
    await expect(client.flush()).rejects.toMatchObject({ code: "ENVIRONMENT_EXPIRED" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.evaluateDetails("new-checkout", false)).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "ENVIRONMENT_EXPIRED",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).not.toContain("retry");
    await client.close();
  });
});
