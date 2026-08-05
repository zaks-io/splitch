import { describe, expect, it } from "vitest";
import { StaticSaltStore } from "../assignment/assignment-store-test-fixtures";
import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  LIVE_RUN_ID,
} from "./evaluate-path-test-fixtures";
import { assertStrongTicketKey, mintExposureTicket } from "./exposure-ticket";

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
        ticketKey: "splitch-test-exposure-ticket-key-32chars",
        now: () => new Date("2026-07-03T00:00:00.000Z"),
      },
    );

    const [payload, signature, extra] = ticket.split(".");
    expect(payload?.length).toBeGreaterThan(10);
    expect(signature?.length).toBeGreaterThan(10);
    expect(extra).toBeUndefined();
    // Opaque: raw targeting key never appears in the ticket bytes.
    expect(ticket).not.toContain("user-1");
    expect(payload).toBeDefined();
    if (payload === undefined) throw new Error("expected ticket payload");
    expect(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).toContain(FLAG_KEY);
  });

  it("rejects a short ticket key", () => {
    expect(() => assertStrongTicketKey("too-short")).toThrow(/EXPOSURE_TICKET_KEY/);
  });
});
