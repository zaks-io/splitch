import { describe, expect, it } from "vitest";
import { overviewFlagChanges } from "./overview-flag-changes";
import { FLAG_CHANGE_LIMIT, FLAG_CHANGE_WINDOW_DAYS } from "./overview-thresholds";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const DAY_MS = 86_400_000;

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

const flags = [
  { id: "flag_a", key: "checkout-redesign", name: "Checkout redesign" },
  { id: "flag_b", key: "search-ranking", name: "Search ranking" },
  { id: "flag_c", key: "pricing-page", name: "Pricing page" },
];

describe("overviewFlagChanges", () => {
  it("drops Flag Configuration changed before the window", () => {
    const changes = overviewFlagChanges(
      [
        { flagId: "flag_a", enabled: true, updatedAt: isoDaysAgo(1) },
        { flagId: "flag_b", enabled: false, updatedAt: isoDaysAgo(FLAG_CHANGE_WINDOW_DAYS + 1) },
      ],
      flags,
      NOW,
    );

    expect(changes.map((change) => change.flagKey)).toEqual(["checkout-redesign"]);
  });

  it("orders by most recent and caps the list", () => {
    const configs = Array.from({ length: FLAG_CHANGE_LIMIT + 2 }, (_unused, index) => ({
      flagId: `flag_${index}`,
      enabled: index % 2 === 0,
      updatedAt: isoDaysAgo(index * 0.5),
    }));
    const manyFlags = configs.map((config, index) => ({
      id: config.flagId,
      key: `flag-key-${index}`,
      name: `Flag ${index}`,
    }));

    const changes = overviewFlagChanges(configs, manyFlags, NOW);

    expect(changes).toHaveLength(FLAG_CHANGE_LIMIT);
    expect(changes.map((change) => change.flagKey)).toEqual([
      "flag-key-0",
      "flag-key-1",
      "flag-key-2",
      "flag-key-3",
      "flag-key-4",
    ]);
  });

  it("carries the Configuration's enabled state, not the Flag definition's", () => {
    const changes = overviewFlagChanges(
      [{ flagId: "flag_c", enabled: false, updatedAt: isoDaysAgo(2) }],
      flags,
      NOW,
    );

    expect(changes[0]).toEqual({
      flagId: "flag_c",
      flagKey: "pricing-page",
      flagName: "Pricing page",
      enabled: false,
      updatedAt: isoDaysAgo(2),
    });
  });

  it("fails loud on a Configuration whose Flag is missing", () => {
    expect(() =>
      overviewFlagChanges(
        [{ flagId: "flag_ghost", enabled: true, updatedAt: isoDaysAgo(1) }],
        flags,
        NOW,
      ),
    ).toThrow(/missing Flag/u);
  });

  it("fails loud on an unparseable timestamp instead of silently dropping the row", () => {
    expect(() =>
      overviewFlagChanges(
        [{ flagId: "flag_a", enabled: true, updatedAt: "not-a-date" }],
        flags,
        NOW,
      ),
    ).toThrow(/invalid updated_at/u);
  });
});
