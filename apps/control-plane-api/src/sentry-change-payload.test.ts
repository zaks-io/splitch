import type { FlagChangeEventRow } from "@splitch/db";
import { describe, expect, it } from "vitest";
import { sentryFlagLogBody, sentryTimestamp, unattributedSeqs } from "./sentry-change-payload";

function event(overrides: Partial<FlagChangeEventRow> = {}): FlagChangeEventRow {
  return {
    seq: 7,
    appId: "app_a",
    environmentId: "env_a",
    flagKey: "checkout-flow",
    action: "updated",
    targetType: "flag_config",
    actorRef: "user_01H",
    actorVia: "api-key",
    changedAt: "2026-08-25T12:34:56.789Z",
    ...overrides,
  };
}

describe("Sentry flag-log payload", () => {
  it("emits created_at without fractional seconds or a timezone suffix", () => {
    // Sentry rejects both with a 400, and toISOString() produces both.
    expect(sentryTimestamp("2026-08-25T12:34:56.789Z")).toBe("2026-08-25T12:34:56");
    expect(sentryTimestamp("2026-01-02T00:00:00.000Z")).toBe("2026-01-02T00:00:00");
  });

  it("throws rather than guessing at a timestamp it cannot parse", () => {
    expect(() => sentryTimestamp("2026-08-25 12:34:56")).toThrow(/unparseable/);
  });

  it("maps a change to the documented entry shape with seq as change_id", () => {
    expect(sentryFlagLogBody([event()])).toEqual({
      data: [
        {
          action: "updated",
          change_id: 7,
          created_at: "2026-08-25T12:34:56",
          created_by: { id: "user_01H", type: "id" },
          flag: "checkout-flow",
        },
      ],
      meta: { version: 1 },
    });
  });

  it("says unattributed rather than naming someone who did nothing", () => {
    const body = sentryFlagLogBody([event({ actorRef: null, targetType: "variant" })]);
    expect(body.data[0]?.created_by).toEqual({ id: "unattributed", type: "name" });
    expect(unattributedSeqs([event(), event({ seq: 9, actorRef: null })])).toEqual([9]);
  });
});
