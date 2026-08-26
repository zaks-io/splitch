import type { FlagChangeEventRow } from "@splitch/db";

/**
 * Projection from the flag-change log onto Sentry's Generic Flag Log body.
 *
 * Contract (getsentry/sentry `src/sentry/flags/docs/api.md`, "Create Generic
 * Flag Log"): every field of every `data[]` entry is required, `meta.version` is
 * required, and `change_id` is documented as "a 64-bit idempotency token
 * representing a unique change group", which is why redelivering a batch after
 * a failed attempt is safe and no delivery outbox is needed.
 */

const SENTRY_FLAG_LOG_VERSION = 1;

/**
 * Sentry accepts no fractional seconds and no timezone suffix. `toISOString()`
 * emits both, and D1 stores both, so the conversion is explicit rather than a
 * substring gamble. It is the same class of bug that took Tinybird's usage
 * endpoint down on a DateTime64 parameter.
 */
export function sentryTimestamp(isoUtc: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(isoUtc);
  if (!match) throw new Error(`sentry change tracking: unparseable changed_at ${isoUtc}`);
  return `${match[1]}T${match[2]}`;
}

interface SentryFlagLogEntry {
  action: "created" | "updated" | "deleted";
  change_id: number;
  created_at: string;
  created_by: { id: string; type: "id" | "name" };
  flag: string;
}

export interface SentryFlagLogBody {
  data: SentryFlagLogEntry[];
  meta: { version: number };
}

/**
 * Changes that no column can attribute: a Variant edit (the Variant write path
 * never stamps an actor), a targeting-rule row, a Flag deleted by a path that
 * left `updated_by` unset.
 *
 * Sentry requires `created_by`, so the choice is to drop the change or to say
 * plainly that it is unattributed. Dropping it would hide a real production
 * change from the correlation Sentry exists to do, and a fabricated user id
 * would name someone who did nothing. `type: "name"` renders this verbatim in
 * Sentry's UI rather than pretending to be an account.
 *
 * Never silent: `dispatchSentryWebhooks` logs the count and the seqs.
 */
const UNATTRIBUTED = { id: "unattributed", type: "name" } as const;

export function sentryFlagLogBody(events: readonly FlagChangeEventRow[]): SentryFlagLogBody {
  return {
    data: events.map((event) => ({
      action: event.action,
      change_id: event.seq,
      created_at: sentryTimestamp(event.changedAt),
      created_by: event.actorRef ? { id: event.actorRef, type: "id" as const } : UNATTRIBUTED,
      flag: event.flagKey,
    })),
    meta: { version: SENTRY_FLAG_LOG_VERSION },
  };
}

export function unattributedSeqs(events: readonly FlagChangeEventRow[]): number[] {
  return events.filter((event) => !event.actorRef).map((event) => event.seq);
}
