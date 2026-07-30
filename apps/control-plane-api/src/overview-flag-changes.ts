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
 * Start of the "recently changed" window, as an ISO-8601 instant.
 *
 * Exported so the bounded D1 read and this in-memory filter cut at exactly the
 * same instant. Two independently computed windows could disagree, and a row the
 * SQL admitted but this dropped would make the truncation flag describe a page
 * larger than the one returned.
 */
export function flagChangeWindowStart(now: Date): string {
  return new Date(now.getTime() - FLAG_CHANGE_WINDOW_DAYS * DAY_MS).toISOString();
}

export interface OverviewFlagChanges {
  /** At most `FLAG_CHANGE_LIMIT` changes, newest first. */
  readonly recentlyChanged: OverviewFlagConfigChange[];
  /**
   * How many changes fell inside the window before the display cap was applied.
   *
   * Counted, never assumed. The caller pairs it with the display cap to decide
   * whether the card is showing a head rather than a whole list, and with its own
   * read bound to decide whether this number is a total or a floor.
   */
  readonly changedCount: number;
}

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
): OverviewFlagChanges {
  const byId = new Map(flags.map((flag) => [flag.id, flag]));
  const since = Date.parse(flagChangeWindowStart(now));
  const inWindow = configs
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
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  // The count is taken BEFORE the cap, which is the whole point: after the slice
  // there is nothing left to distinguish "5 changed" from "40 changed, 5 shown".
  return { recentlyChanged: inWindow.slice(0, FLAG_CHANGE_LIMIT), changedCount: inWindow.length };
}
