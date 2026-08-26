import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { userRef } from "./columns";

/**
 * Append-only change log for the Flag domain.
 *
 * WHY this exists: nothing else in the corpus records *what changed, when, and
 * by whom*. `flags` carries only last-writer `created_by`/`updated_by`;
 * `flag_configs`, the table holding `enabled` and `rollout`, carried no actor
 * at all until this migration added one. `approval_requests` records only the
 * subset of mutations that pass through an Approval gate, so an ordinary toggle
 * left no trace.
 *
 * Rows are written by D1 TRIGGERS (see 0026_flag_change_log.sql), never by repo
 * calls. A trigger cannot be bypassed by a new route, a batch write, or a future
 * repo method that forgets to emit, which is the whole point of an audit
 * record. The vocabulary (`action` / `target_type` / `actor_ref` / `diff_json`)
 * mirrors `approval_requests` rather than inventing synonyms for the same ideas.
 *
 * It carries NO foreign keys on purpose. D1 enforces them, so an AFTER DELETE
 * trigger inserting a row that referenced the just-deleted Flag would abort the
 * delete outright. Beyond the mechanics, an audit record has to outlive the row
 * it audits: "who deleted this Flag" is worthless if it dies with the Flag.
 *
 * `seq` is an INTEGER PRIMARY KEY AUTOINCREMENT, so it is monotonic and 64-bit.
 * That makes it directly usable as the outbound idempotency token for
 * integrations that consume this log (Sentry's `change_id`), and it is why this
 * table needs no companion delivery/outbox table: a per-installation cursor over
 * `seq` gives at-least-once delivery with natural batching.
 */
export const flagChangeEvents = sqliteTable(
  "flag_change_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    appId: text("app_id").notNull(),
    /**
     * NULL for App-level Flag DEFINITION changes (flags, variants), which have
     * no Environment axis (ADR-0027). Per-Environment CONFIGURATION changes
     * (flag_configs, targeting_rules, runs) always carry one.
     */
    environmentId: text("environment_id"),
    flagId: text("flag_id").notNull(),
    /**
     * Denormalized on purpose: the Flag key at the time of the change. A later
     * rename must not rewrite history, and a consumer reading this log must not
     * need a join against a row that may since have been deleted.
     */
    flagKey: text("flag_key").notNull(),
    /** created | updated | deleted. */
    action: text("action").notNull(),
    /** flag | flag_config | variant | targeting_rule | run. */
    targetType: text("target_type").notNull(),
    /** Opaque WorkOS user reference or a tombstone; never PII (ADR-0032). */
    actorRef: userRef("actor_ref"),
    /** The surface the change arrived through (api-key, session, system). */
    actorVia: text("actor_via"),
    changedAt: text("changed_at").notNull(),
    /** JSON object of the changed fields; NULL when the trigger has no diff. */
    diffJson: text("diff_json"),
  },
  (table) => [
    index("flag_change_events_scope_seq_idx").on(table.appId, table.environmentId, table.seq),
    index("flag_change_events_changed_at_idx").on(table.changedAt),
  ],
);
