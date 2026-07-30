import type { OverviewFlagConfigChange } from "@splitch/contracts";
import { FLAG_CHANGE_LIMIT, FLAG_CHANGE_WINDOW_DAYS } from "./overview-thresholds";

interface FlagConfigRow {
  flagId: string;
  enabled: boolean;
  updatedAt: string;
}

interface FlagRow {
  id: string;
  key: string;
  name: string;
}

const DAY_MS = 86_400_000;

/**
 * The most recently changed Flag Configuration in this Environment.
 *
 * Sourced from `flag_configs.updated_at`, which is the only change record that
 * exists today: there is no audit table (SPL-161 owns it) and `flag_configs` has
 * no `updated_by`. So this card reports WHAT changed and WHEN, and deliberately
 * attributes it to nobody rather than guessing an actor.
 */
export function overviewFlagChanges(
  configs: readonly FlagConfigRow[],
  flags: readonly FlagRow[],
  now: Date,
): OverviewFlagConfigChange[] {
  const byId = new Map(flags.map((flag) => [flag.id, flag]));
  const since = now.getTime() - FLAG_CHANGE_WINDOW_DAYS * DAY_MS;
  return configs
    .flatMap((config) => {
      const changedAt = Date.parse(config.updatedAt);
      // An unparseable timestamp is a corrupt row, not a stale one. Dropping it
      // silently would shrink the card; failing here surfaces it.
      if (Number.isNaN(changedAt)) {
        throw new Error(`Flag Configuration for ${config.flagId} has an invalid updated_at`);
      }
      if (changedAt < since) return [];
      const flag = byId.get(config.flagId);
      if (!flag) throw new Error(`Flag Configuration references missing Flag ${config.flagId}`);
      return [
        {
          flagId: flag.id,
          flagKey: flag.key,
          flagName: flag.name,
          enabled: config.enabled,
          updatedAt: config.updatedAt,
        },
      ];
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, FLAG_CHANGE_LIMIT);
}
