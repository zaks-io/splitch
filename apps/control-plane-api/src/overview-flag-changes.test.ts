import type { FlagChangeLogRow } from "@splitch/db";
import { describe, expect, it } from "vitest";
import { overviewFlagChanges } from "./overview-flag-changes";
import { FLAG_CHANGE_LIMIT, FLAG_CHANGE_WINDOW_DAYS } from "./overview-thresholds";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const DAY_MS = 86_400_000;

function event(overrides: Partial<FlagChangeLogRow> = {}): FlagChangeLogRow {
  return {
    seq: 1,
    appId: "app_checkout",
    environmentId: "env_prod",
    flagId: "flag_checkout",
    flagKey: "checkout-redesign",
    action: "updated",
    targetType: "flag_config",
    actorRef: null,
    actorVia: null,
    changedAt: NOW.toISOString(),
    diffJson: null,
    ...overrides,
  };
}

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

describe("overviewFlagChanges", () => {
  it("counts the inclusive window without admitting old or future events", () => {
    const result = overviewFlagChanges(
      [
        event({ seq: 1, changedAt: isoDaysAgo(FLAG_CHANGE_WINDOW_DAYS) }),
        event({ seq: 2, changedAt: isoDaysAgo(FLAG_CHANGE_WINDOW_DAYS + 1) }),
        event({ seq: 3, changedAt: isoDaysAgo(-1) }),
      ],
      NOW,
    );

    expect(result.changedCount).toBe(1);
    expect(result.recentlyChanged.map((change) => change.seq)).toEqual([1]);
  });

  it("counts distinct events on the same Flag, then caps in authoritative sequence order", () => {
    const events = Array.from({ length: FLAG_CHANGE_LIMIT + 2 }, (_, index) =>
      event({ seq: index + 1 }),
    );
    const result = overviewFlagChanges(events, NOW);

    expect(result.changedCount).toBe(FLAG_CHANGE_LIMIT + 2);
    expect(result.recentlyChanged.map((change) => change.seq)).toEqual([7, 6, 5, 4, 3]);
  });

  it("projects definition, deletion and Configuration events without inventing landing values or actors", () => {
    const result = overviewFlagChanges(
      [
        event({ seq: 1, action: "created", targetType: "flag", environmentId: null }),
        event({ seq: 2, action: "deleted", targetType: "flag", environmentId: null }),
        event({ seq: 3, actorRef: "user_recorded", actorVia: "session" }),
      ],
      NOW,
    );

    expect(result.recentlyChanged).toEqual([
      {
        seq: 3,
        flagId: "flag_checkout",
        flagKey: "checkout-redesign",
        action: "updated",
        targetType: "flag_config",
        actorRef: "user_recorded",
        actorVia: "session",
        changedAt: NOW.toISOString(),
      },
      expect.objectContaining({ seq: 2, action: "deleted", actorRef: null, actorVia: null }),
      expect.objectContaining({ seq: 1, action: "created", actorRef: null, actorVia: null }),
    ]);
    for (const change of result.recentlyChanged) {
      expect(change).not.toHaveProperty("enabled");
      expect(change).not.toHaveProperty("flagName");
      expect(change).not.toHaveProperty("diffJson");
    }
  });

  it("fails loudly on an invalid timestamp", () => {
    expect(() => overviewFlagChanges([event({ changedAt: "not-a-date" })], NOW)).toThrow(
      /invalid changed_at/u,
    );
  });

  it("fails loudly on an unknown stored target type", () => {
    expect(() => overviewFlagChanges([event({ targetType: "unknown" })], NOW)).toThrow();
  });
});
