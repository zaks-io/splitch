import { appScope, envScope } from "@splitch/db";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_TEST_TIMEOUT,
  repository,
  setupAttentionRollupFixture,
} from "./attention-rollup-fixture";
import { ids, NOW, NOW_MS } from "./config-store-fixture-data";
import { FLAG_CHANGE_READ_LIMIT } from "./overview-thresholds";
import { body, CALM, overview, readerFor } from "./panel-overview-fixture";

/**
 * The Overview's Flag Configuration scan is bounded, and the bound is reported.
 *
 * The seeded graph already carries one Flag Configuration in the Production
 * Environment, changed at `NOW`, so every count below is "seeded + 1".
 */
setupAttentionRollupFixture();

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Adds `count` Flags, each with its own Flag Configuration in the Production
 * Environment. `changedAt` decides whether they land inside the card's window.
 */
async function seedChangedFlagConfigs(count: number, changedAt: (index: number) => string) {
  const repo = repository();
  const aScope = appScope(ids.appId);
  const eScope = envScope(ids.appId, ids.environmentId);
  for (let index = 0; index < count; index += 1) {
    const flagId = `flag_bulk_${String(index).padStart(3, "0")}`;
    await repo.flags.flags.insert(aScope, {
      id: flagId,
      appId: ids.appId,
      key: `bulk-flag-${index}`,
      name: `Bulk flag ${index}`,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.flags.flagConfigs.insert(eScope, {
      id: `flag_config_bulk_${String(index).padStart(3, "0")}`,
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId,
      enabled: index % 2 === 0,
      availableVariantNames: JSON.stringify([]),
      createdAt: NOW,
      updatedAt: changedAt(index),
    });
  }
}

/** Staggered inside the window: index 0 is the most recent of the bulk rows. */
function insideWindow(index: number): string {
  return new Date(NOW_MS - (index + 1) * MINUTE_MS).toISOString();
}

describe("panelOverviewRead Flag Configuration read bound", () => {
  it(
    "reports the scan as truncated once more changed than the ceiling, instead of dropping rows quietly",
    async () => {
      // Ceiling + 1 in-window rows in total, counting the seeded one.
      await seedChangedFlagConfigs(FLAG_CHANGE_READ_LIMIT, insideWindow);

      const overviewBody = await body(await overview(readerFor({ [ids.liveRunId]: CALM })));

      // The signal itself is the assertion: a row count alone would pass even if
      // truncation were never wired to the response (ADR-0036).
      expect(overviewBody.flagConfiguration.readTruncated).toBe(true);
      expect(overviewBody.flagConfiguration.readLimit).toBe(FLAG_CHANGE_READ_LIMIT);
      // Newest first: the seeded Flag Configuration is stamped at NOW, ahead of
      // every bulk row, so truncation drops the OLDEST changes and not the newest.
      expect(overviewBody.flagConfiguration.recentlyChanged[0]?.flagKey).toBe(ids.flagKey);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "does not claim truncation when the scan lands exactly on the ceiling",
    async () => {
      await seedChangedFlagConfigs(FLAG_CHANGE_READ_LIMIT - 1, insideWindow);

      const overviewBody = await body(await overview(readerFor({ [ids.liveRunId]: CALM })));

      expect(overviewBody.flagConfiguration.readTruncated).toBe(false);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "counts only what changed inside the window, so an old Flag catalog cannot trip the ceiling",
    async () => {
      // Past the ceiling in row count, but all changed long before the window.
      await seedChangedFlagConfigs(FLAG_CHANGE_READ_LIMIT + 5, (index) =>
        new Date(NOW_MS - (30 + index) * DAY_MS).toISOString(),
      );

      const overviewBody = await body(await overview(readerFor({ [ids.liveRunId]: CALM })));

      expect(overviewBody.flagConfiguration.readTruncated).toBe(false);
      expect(overviewBody.flagConfiguration.recentlyChanged).toEqual([
        {
          flagId: ids.flagId,
          flagKey: ids.flagKey,
          flagName: "Checkout redesign",
          enabled: false,
          updatedAt: NOW,
        },
      ]);
    },
    ATTENTION_TEST_TIMEOUT,
  );

  it(
    "truncates the same rows on every read when the change timestamps collide",
    async () => {
      // Every row stamped at the same instant, which is what a batch write looks
      // like: `updated_at` alone cannot decide which rows the LIMIT keeps.
      await seedChangedFlagConfigs(FLAG_CHANGE_READ_LIMIT, () => NOW);

      const first = await body(await overview(readerFor({ [ids.liveRunId]: CALM })));
      const second = await body(await overview(readerFor({ [ids.liveRunId]: CALM })));

      expect(first.flagConfiguration.readTruncated).toBe(true);
      // Weak on its own: a partial order can still be stable within one process,
      // and this passes with the tiebreaker removed. It is here for the shuffle an
      // operator would actually see, not as the total-order proof.
      expect(second.flagConfiguration.recentlyChanged).toEqual(
        first.flagConfiguration.recentlyChanged,
      );
      // THIS is the total-order proof, and it is what fails if
      // `desc(flagConfigs.id)` is dropped. The tiebreaker is `flag_configs.id`
      // DESC and the id is the table's PRIMARY KEY, so exactly one head is
      // reachable: "flag_config_checkout_prod" sorts above every
      // "flag_config_bulk_NNN", then the bulk ids descend.
      expect(first.flagConfiguration.recentlyChanged.map((change) => change.flagKey)).toEqual([
        ids.flagKey,
        "bulk-flag-49",
        "bulk-flag-48",
        "bulk-flag-47",
        "bulk-flag-46",
      ]);
    },
    ATTENTION_TEST_TIMEOUT,
  );
});
