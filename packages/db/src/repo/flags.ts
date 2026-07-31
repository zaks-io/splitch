import { and, desc, eq, inArray } from "drizzle-orm";
import { flagConfigs, flags, segments, targetingRules, variants } from "../schema/index";
import {
  appliedRequestUpdate,
  appliedReviewInsert,
  approvalPendingCondition,
} from "./approval-atomic";
import type { ApprovalCommit } from "./approval-types";
import type { Db } from "./client";
import { makeFlagConfigOps, scopedFlagConfig, scopedTargetingRule } from "./flag-config-ops";
import { type FlagInScope, makeVariantOps } from "./flag-variant-ops";
import { idBatches } from "./id-batches";
import type { TenantScope } from "./scope";
import { envScope } from "./scope";
import { scopedTable } from "./scoped-table";

/**
 * Flag-domain repository. App-scoped: flags, segments. Per-Environment:
 * flag_configs, targeting_rules. Variants are the one table with no `app_id`
 * column — the catalog is reached transitively through its parent flag
 * (flag_id → flags.app_id), so variant access is gated by first proving the flag
 * is in the caller's App scope. There is no way to read a variant without that
 * App-scoped flag lookup, so the tenant boundary still holds for the catalog.
 */
export function makeFlagRepo(db: Db) {
  const flagsTable = scopedTable(db, flags);
  const flagConfigsTable = scopedTable(db, flagConfigs);
  const targetingRulesTable = scopedTable(db, targetingRules);
  const segmentsTable = scopedTable(db, segments);

  async function flagInScope(
    scope: TenantScope,
    flagId: string,
  ): Promise<typeof flags.$inferSelect | null> {
    return flagsTable.findOne(scope, eq(flags.id, flagId));
  }

  return {
    flags: flagsTable,
    flagConfigs: flagConfigsTable,
    targetingRules: targetingRulesTable,
    segments: segmentsTable,

    getFlag(scope: TenantScope, flagId: string) {
      return flagsTable.findOne(scope, eq(flags.id, flagId));
    },

    /**
     * The App's Flag with this key, or null. Keyed on the `(app_id, key)` unique
     * index, so it costs an index probe whatever the App holds.
     *
     * "Is this key taken" has no honest partial answer, so it is the one Flag
     * read that must never be served from a bounded page of the catalog: a row a
     * LIMIT skipped reads back as "the key is free" and permits a duplicate write
     * (ADR-0036). A keyed lookup removes the scan instead of bounding it.
     */
    getFlagByKey(scope: TenantScope, key: string) {
      return flagsTable.findOne(scope, eq(flags.key, key));
    },

    /**
     * Insert a Flag, reporting a key collision as a result rather than throwing.
     *
     * The `flags_app_key_unique` index is what actually enforces uniqueness; the
     * caller's preceding `getFlagByKey` only buys a clean field error on the
     * common path. Between that read and this write, a concurrent create can take
     * the key — here the loser's INSERT violates the index and comes back as
     * `key_conflict`, so the race ends in a refused write, not a duplicate.
     */
    async createFlag(
      scope: TenantScope,
      values: typeof flags.$inferInsert,
    ): Promise<CreateFlagResult> {
      try {
        return { ok: true, flag: await flagsTable.insert(scope, values) };
      } catch (error) {
        if (!isFlagKeyConflict(error)) throw error;
        return { ok: false, reason: "key_conflict" };
      }
    },

    updateFlag(
      scope: TenantScope,
      flagId: string,
      patch: Partial<
        Pick<
          typeof flags.$inferInsert,
          "name" | "description" | "schema" | "defaultVariantId" | "updatedAt" | "updatedBy"
        >
      >,
    ): Promise<typeof flags.$inferSelect | null> {
      return flagsTable.update(scope, patch, eq(flags.id, flagId)).then((rows) => rows[0] ?? null);
    },

    removeFlag(scope: TenantScope, flagId: string): Promise<number> {
      return flagsTable.remove(scope, eq(flags.id, flagId));
    },

    deleteFlagCascade: makeDeleteFlagCascade(db, flagInScope),

    ...makeVariantOps(db, flagsTable, flagInScope),

    ...makeFlagConfigOps(db, flagConfigsTable, targetingRulesTable),

    /**
     * One bounded page of the App's Flag catalog, newest first.
     *
     * Exists so the Flag list costs what it renders rather than what the App has
     * accumulated. It is also the surface the Overview's truncation notice sends
     * an operator to, so the App most likely to reach it is exactly the App whose
     * catalog is large — an unbounded read here would move the problem, not fix it.
     *
     * Ordered by `(created_at DESC, id DESC)`. `created_at` is fixed-width
     * ISO-8601 TEXT, so the lexicographic comparison SQLite applies IS the
     * chronological one. `id` is the table's PRIMARY KEY, which makes the pair a
     * TOTAL order: Flags created in one seeded or scripted batch share a
     * `created_at`, and without the tiebreaker which of the tied rows the `LIMIT`
     * dropped would vary between two otherwise identical reads.
     *
     * Ask for one row more than you intend to keep and you learn whether you
     * truncated, rather than inferring it from a full page.
     */
    listFlagPage(scope: TenantScope, limit: number) {
      return flagsTable.findMany(scope, undefined, {
        limit,
        orderBy: [desc(flags.createdAt), desc(flags.id)],
      });
    },

    /**
     * App-scoped Flag fetch by a set of IDs, for callers that already hold a
     * bounded set of `flag_id`s and only need to resolve them to keys and names.
     * Reading the App's whole Flag catalog to build that lookup makes the caller's
     * cost scale with the App instead of with its own bound.
     *
     * Batched because D1 caps bound parameters per statement; see `idBatches`.
     */
    async listFlagsByIds(scope: TenantScope, ids: readonly string[]) {
      if (ids.length === 0) return [] as (typeof flags.$inferSelect)[];
      const pages = await Promise.all(
        idBatches(ids).map((batch) => flagsTable.findMany(scope, inArray(flags.id, [...batch]))),
      );
      return pages.flat();
    },

    /**
     * App-scoped Segment fetch by a set of IDs (e.g. for a draft Run snapshot).
     *
     * Batched because D1 caps bound parameters per statement; see `idBatches`.
     * The ids come from `experiment.draft_segment_ids`, written from the request
     * body against a schema with no length cap, so this set is caller-controlled
     * and unbounded: unbatched, a draft carrying 100+ Segments made Start fail
     * with `too many SQL variables` rather than start the Run.
     */
    async listSegmentsByIds(scope: TenantScope, ids: readonly string[]) {
      if (ids.length === 0) return [] as (typeof segments.$inferSelect)[];
      const pages = await Promise.all(
        idBatches(ids).map((batch) => segmentsTable.findMany(scope, inArray(segments.id, batch))),
      );
      return pages.flat();
    },

    getSegment(scope: TenantScope, segmentId: string) {
      return segmentsTable.findOne(scope, eq(segments.id, segmentId));
    },

    updateSegment(
      scope: TenantScope,
      segmentId: string,
      patch: Partial<
        Pick<typeof segments.$inferInsert, "name" | "description" | "conditions" | "updatedAt">
      >,
    ): Promise<typeof segments.$inferSelect | null> {
      return segmentsTable
        .update(scope, patch, eq(segments.id, segmentId))
        .then((rows) => rows[0] ?? null);
    },

    removeSegment(scope: TenantScope, segmentId: string): Promise<number> {
      return segmentsTable.remove(scope, eq(segments.id, segmentId));
    },
  };
}

export type CreateFlagResult =
  | { ok: true; flag: typeof flags.$inferSelect }
  | { ok: false; reason: "key_conflict" };

/**
 * SQLite reports a composite unique-index violation by COLUMN LIST, not by index
 * name, so matching `flags_app_key_unique` would never fire. Matching the whole
 * constraint string also keeps this from swallowing a different fault on the same
 * columns (a `NOT NULL constraint failed: flags.key` names that column too, and
 * answering a broken write with "choose another key" is advice that can never
 * succeed). Every other error still throws.
 */
const FLAG_KEY_UNIQUE_VIOLATION = "UNIQUE constraint failed: flags.app_id, flags.key";

/** SQLite's extended result code for the same failure, which no column list can spell. */
const SQLITE_UNIQUE_CODE = "SQLITE_CONSTRAINT_UNIQUE";

/**
 * Classify a write failure WITHOUT ever reading a message that embeds the bound
 * parameters.
 *
 * D1 exposes no structured code on the thrown Error — the extended result code
 * only ever appears in prose — so this has to match text. That makes WHICH text
 * it reads the whole security property. Drizzle's top-level `DrizzleQueryError`
 * message carries the SQL *and its parameters*, so a Flag `key`, `name` or
 * `description` containing the constraint string would classify ANY insert
 * failure as a collision: a lost connection would come back as "flag key already
 * exists", telling an operator to pick a different key when the key was free and
 * nothing was written. A disguised default with an impossible remedy (ADR-0036),
 * and worse than the 500 it replaces, because the 500 was at least honest.
 *
 * So every layer carrying bound parameters is skipped, wherever it sits in the
 * chain. That is stated as a property of the layer rather than as "skip the top
 * one", because a nesting change that moved the wrapper down a level would
 * silently reopen the hole, and because it still classifies correctly if the seam
 * ever throws D1's error unwrapped. What is left is D1's own text, which no
 * caller can author. Both the constraint string and the extended result code must
 * appear in that SAME message: the column list identifies the collision, the
 * result code is the proof it was a uniqueness failure at all.
 */
function isFlagKeyConflict(error: unknown): boolean {
  for (const message of messagesNotCarryingParameters(error)) {
    if (message.includes(FLAG_KEY_UNIQUE_VIOLATION) && message.includes(SQLITE_UNIQUE_CODE)) {
      return true;
    }
  }
  return false;
}

/** The `cause` chain, minus every layer that stringifies the caller's values. */
function* messagesNotCarryingParameters(error: unknown): Generator<string> {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (!embedsBoundParameters(current)) {
      yield current instanceof Error ? current.message : String(current);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
}

/** A query error, which stringifies the caller's values into its own message. */
function embedsBoundParameters(error: unknown): boolean {
  return typeof error === "object" && error !== null && "params" in error;
}

function makeDeleteFlagCascade(db: Db, flagInScope: FlagInScope) {
  /**
   * When an Approval Review authorizes the delete, EVERY statement in the
   * cascade is guarded by that Review's Request still being pending. Guarding
   * only the parent row would let a resolved or stale Request still wipe a
   * `confirm` Environment's Configurations and targeting rules.
   */
  return async function deleteFlagCascade(
    scope: TenantScope,
    flagId: string,
    environmentIds: readonly string[],
    options?: { approval?: ApprovalCommit },
  ): Promise<boolean> {
    const flag = await flagInScope(scope, flagId);
    if (!flag) return false;

    const approval = options?.approval;
    const pending = approval ? [approvalPendingCondition(db, scope, approval)] : [];
    const batch = [
      ...environmentIds.flatMap((environmentId) => {
        const env = envScope(scope.appId, environmentId);
        return [
          db
            .delete(targetingRules)
            .where(and(scopedTargetingRule(env, flagId), ...pending))
            .returning(),
          db
            .delete(flagConfigs)
            .where(and(scopedFlagConfig(env, flagId), ...pending))
            .returning(),
        ];
      }),
      db
        .delete(variants)
        .where(and(eq(variants.flagId, flagId), ...pending))
        .returning(),
      db
        .delete(flags)
        .where(and(eq(flags.appId, scope.appId), eq(flags.id, flagId), ...pending))
        .returning(),
      ...(approval
        ? [appliedReviewInsert(db, scope, approval), appliedRequestUpdate(db, scope, approval)]
        : []),
    ];
    await db.batch(batch as unknown as Parameters<Db["batch"]>[0]);
    return approval ? (await flagInScope(scope, flagId)) === null : true;
  };
}
