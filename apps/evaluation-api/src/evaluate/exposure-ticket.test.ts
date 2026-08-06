import { describe, expect, it } from "vitest";
import { StaticSaltStore } from "../assignment/assignment-store-test-fixtures";
import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  LIVE_RUN_ID,
} from "./evaluate-path-test-fixtures";
import { assertStrongTicketKey, mintExposureTicket, verifyExposureTicket } from "./exposure-ticket";

const TICKET_KEY = ["splitch-test-exposure-ticket-key", "32chars"].join("-");

describe("mintExposureTicket", () => {
  it("mints an opaque base64url.payload.signature ticket", async () => {
    const ticket = await mintExposureTicket(
      {
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        flagKey: FLAG_KEY,
        idType: "user",
        liveRunId: LIVE_RUN_ID,
        targetingKey: "user-1",
        variant: "treatment",
      },
      {
        saltStore: new StaticSaltStore(),
        ticketKey: TICKET_KEY,
        now: () => new Date("2026-07-03T00:00:00.000Z"),
      },
    );

    const [payload, signature, extra] = ticket.split(".");
    expect(payload?.length).toBeGreaterThan(10);
    expect(signature?.length).toBeGreaterThan(10);
    expect(extra).toBeUndefined();
    expect(payload).toBeDefined();
    if (payload === undefined) throw new Error("expected ticket payload");
    const decodedPayload = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const decoded = JSON.parse(decodedPayload) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      flag_key: FLAG_KEY,
      targeting_key_hash: expect.any(String),
    });
    expect(decodedPayload).not.toContain("user-1");
  });

  it("rejects a short ticket key", () => {
    expect(() => assertStrongTicketKey("too-short")).toThrow(/EXPOSURE_TICKET_KEY/);
  });

  it("verifies a freshly minted ticket and rejects MAC / TTL failures", async () => {
    const deps = {
      saltStore: new StaticSaltStore(),
      ticketKey: TICKET_KEY,
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    };
    const ticket = await mintExposureTicket(
      {
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        flagKey: FLAG_KEY,
        idType: "user",
        liveRunId: LIVE_RUN_ID,
        targetingKey: "user-1",
        variant: "treatment",
      },
      deps,
    );

    await expect(verifyExposureTicket(ticket, deps)).resolves.toMatchObject({
      ok: true,
      payload: { flag_key: FLAG_KEY, variant: "treatment" },
    });
    await expect(verifyExposureTicket(`${ticket}x`, deps)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    await expect(
      verifyExposureTicket(ticket, {
        ...deps,
        now: () => new Date("2026-07-05T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "expired" });
  });

  it("rejects a future-dated ticket beyond the clock-skew window", async () => {
    const deps = {
      saltStore: new StaticSaltStore(),
      ticketKey: TICKET_KEY,
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    };
    const future = await mintExposureTicket(
      {
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        flagKey: FLAG_KEY,
        idType: "user",
        liveRunId: LIVE_RUN_ID,
        targetingKey: "user-1",
        variant: "treatment",
      },
      {
        ...deps,
        // Issued 10 minutes ahead of verification clock.
        now: () => new Date("2026-07-03T00:10:00.000Z"),
      },
    );

    await expect(verifyExposureTicket(future, deps)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("accepts a ticket issued within the five-minute clock-skew window", async () => {
    const deps = {
      saltStore: new StaticSaltStore(),
      ticketKey: TICKET_KEY,
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    };
    const nearFuture = await mintExposureTicket(
      {
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        flagKey: FLAG_KEY,
        idType: "user",
        liveRunId: LIVE_RUN_ID,
        targetingKey: "user-1",
        variant: "treatment",
      },
      {
        ...deps,
        // Issued 4 minutes ahead — inside the skew window.
        now: () => new Date("2026-07-03T00:04:00.000Z"),
      },
    );

    await expect(verifyExposureTicket(nearFuture, deps)).resolves.toMatchObject({
      ok: true,
      payload: { flag_key: FLAG_KEY, variant: "treatment" },
    });
  });
});
