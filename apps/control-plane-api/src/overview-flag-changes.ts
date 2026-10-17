import { type OverviewFlagConfigChange, OverviewFlagConfigChangeSchema } from "@splitch/contracts";
import type { FlagChangeLogRow } from "@splitch/db";
import { FLAG_CHANGE_LIMIT, FLAG_CHANGE_WINDOW_DAYS } from "./overview-thresholds";

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

/** Project recorded events without consulting live Flags or Configuration landing values. */
export function overviewFlagChanges(
  events: readonly FlagChangeLogRow[],
  now: Date,
): OverviewFlagChanges {
  const since = Date.parse(flagChangeWindowStart(now));
  const inWindow = events
    .filter((event) => {
      const changedAt = Date.parse(event.changedAt);
      if (!Number.isFinite(changedAt)) {
        throw new Error(`Flag change event ${event.seq} has an invalid changed_at`);
      }
      return changedAt >= since && changedAt <= now.getTime();
    })
    .sort((left, right) => right.seq - left.seq)
    .map((event) =>
      OverviewFlagConfigChangeSchema.parse({
        seq: event.seq,
        flagId: event.flagId,
        flagKey: event.flagKey,
        action: event.action,
        targetType: event.targetType,
        actorRef: event.actorRef,
        actorVia: event.actorVia,
        changedAt: event.changedAt,
      }),
    );
  return { recentlyChanged: inWindow.slice(0, FLAG_CHANGE_LIMIT), changedCount: inWindow.length };
}
