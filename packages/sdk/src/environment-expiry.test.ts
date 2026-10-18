import { afterEach, describe, expect, it, vi } from "vitest";
import { createSplitchClient } from "./client";
import { FakeLogger } from "./test-fixtures";

const expiredResponse = () =>
  Response.json(
    {
      code: "ENVIRONMENT_EXPIRED",
      message: "Temporary Environment has expired",
      details: {
        environmentId: "env_test",
        expiredAt: "2026-10-17T12:00:00.000Z",
        recommendedAction: "CREATE_TEMPORARY_ENVIRONMENT",
      },
    },
    { status: 410 },
  );

afterEach(() => vi.restoreAllMocks());

describe("Temporary Environment expiry in the primary SDK", () => {
  it("preserves the wire code across accessors, logs once per client, and sends each call once", async () => {
    const logger = new FakeLogger();
    const fetch = vi.fn(async () => expiredResponse());
    const client = createSplitchClient({ clientKey: "pk_test", logger, fetch });
    const context = { targetingKey: "entity-1", defaultValue: false };
    expect(await client.evaluateDetails("checkout", context)).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "ENVIRONMENT_EXPIRED",
    });
    expect(await client.evaluate("checkout", context)).toBe(false);
    expect(await client.verify("checkout", context)).toMatchObject({
      reason: "ERROR",
      errorCode: "ENVIRONMENT_EXPIRED",
    });
    await expect(client.evaluateAll(context)).rejects.toMatchObject({
      code: "ENVIRONMENT_EXPIRED",
      status: 410,
    });
    const event = {
      targetingKey: "entity-1",
      eventId: "00000000-0000-4000-8000-000000000001",
      fields: {},
      dimensions: {},
    };
    await expect(client.track("signed_up", event)).rejects.toMatchObject({
      code: "ENVIRONMENT_EXPIRED",
      status: 410,
    });
    await expect(client.activate("signed_up", event)).rejects.toMatchObject({
      code: "ENVIRONMENT_EXPIRED",
      status: 410,
    });
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain("Create a new Temporary Environment");
    expect(logger.errors[0]?.message).not.toContain("retry");

    const second = createSplitchClient({ apiKey: "sk_test", logger, fetch });
    await expect(second.peekVariant("checkout", context)).rejects.toMatchObject({
      code: "ENVIRONMENT_EXPIRED",
      status: 410,
    });
    await expect(second.peekVariant("checkout", context)).rejects.toMatchObject({
      code: "ENVIRONMENT_EXPIRED",
    });
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(logger.errors).toHaveLength(2);
  });

  it("does not suppress other failures after the client has logged expiry", async () => {
    const logger = new FakeLogger();
    const fetch = vi.fn(async () => expiredResponse());
    const client = createSplitchClient({ clientKey: "pk_test", logger, fetch });
    await client.evaluateDetails("checkout", { targetingKey: "entity-1" });
    fetch.mockImplementation(async () =>
      Response.json({ code: "SERVICE_UNAVAILABLE", message: "unavailable" }, { status: 503 }),
    );
    expect(await client.verify("checkout", { targetingKey: "entity-1" })).toMatchObject({
      reason: "ERROR",
      errorCode: "SERVICE_UNAVAILABLE",
    });
    expect(logger.errors).toHaveLength(2);
  });
});
