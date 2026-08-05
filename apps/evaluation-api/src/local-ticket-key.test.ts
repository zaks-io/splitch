import { describe, expect, it } from "vitest";
import { exposureTicketKeyFromEnv } from "./local-ticket-key";

describe("exposureTicketKeyFromEnv", () => {
  it("uses the dedicated secret when present", () => {
    expect(
      exposureTicketKeyFromEnv({
        EXPOSURE_TICKET_KEY: "hosted-ticket-key-at-least-32-chars!!",
        SPLITCH_PLATFORM_TARGET: "production",
      }),
    ).toBe("hosted-ticket-key-at-least-32-chars!!");
  });

  it("allows the local fallback only for explicit local and pr-ci targets", () => {
    expect(exposureTicketKeyFromEnv({ SPLITCH_PLATFORM_TARGET: "local" })).toContain("local");
    expect(exposureTicketKeyFromEnv({ SPLITCH_PLATFORM_TARGET: "pr-ci" })).toContain("local");
  });

  it("fails closed when the platform target is unset or hosted without a secret", () => {
    expect(() => exposureTicketKeyFromEnv({})).toThrow(/EXPOSURE_TICKET_KEY/);
    expect(() => exposureTicketKeyFromEnv({ SPLITCH_PLATFORM_TARGET: "shared-preview" })).toThrow(
      /EXPOSURE_TICKET_KEY/,
    );
    expect(() => exposureTicketKeyFromEnv({ SPLITCH_PLATFORM_TARGET: "production" })).toThrow(
      /EXPOSURE_TICKET_KEY/,
    );
  });
});
