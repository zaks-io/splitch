import { and, eq, sql } from "drizzle-orm";
import { experiments, runs } from "../schema/index";
import type { Db } from "./client";
import type { TenantScope } from "./scope";

/**
 * A live Run freezes both the NAME and the VALUE of every Variant it allocates
 * traffic to.
 *
 * A Run's `allocation` and `variantSet` are frozen at Start and keyed by Variant
 * NAME, while the KV Flag snapshot carries the CURRENT App-level catalog. Rename
 * a Variant under a live Run and the two disagree: the edge assigns the frozen
 * name, fails to find it in the catalog, and answers INTERNAL_SERVER_ERROR for
 * the share of traffic the allocation sends to that arm. Executed proof in
 * `apps/evaluation-api/src/evaluate-renamed-run-arm.test.ts`.
 *
 * The VALUE freeze is the quieter of the two and the more damaging. Swapping the
 * payload under a running arm raises nothing: the write succeeds, KV is
 * republished, and the edge keeps serving that arm — but exposures recorded
 * before and after the swap are both attributed to the same Variant name, so the
 * Run's population silently mixes two different treatments and no error surfaces
 * anywhere. That is the disguised default ADR-0036 forbids.
 *
 * A rename is also the same act as removing the arm from
 * `flag_configs.available_variant_names`, which SPL-118 already refuses. It is
 * checked HERE, at the repository seam, and not in the route handler that
 * happens to reach it: SPL-118 learned twice that a guard bolted onto a subset
 * of the doors is a guard the next door walks around. Both known doors — the
 * direct `PATCH /variants/:name` and an `approve_and_apply` Review of a proposal
 * filed before Start — call `updateVariant`, and so does anything added later.
 *
 * The Variant catalog is App-level (ADR-0028), so ANY Environment holding a live
 * Run on this Flag freezes the name for the whole App. There is no partial
 * rename: the name is one value shared by every Environment's available set.
 */

export interface VariantRunFreeze {
  experimentId: string;
  runId: string;
  /** The Environment whose Run owns the Variant, so the refusal can name it. */
  environmentId: string;
}

/** The frozen properties a write can try to move, named for the renderer. */
export type VariantFrozenChange = "name" | "value";

export interface VariantIdentity {
  id: string;
  name: string;
}

/**
 * The live Run that owns this Variant, or null when the write is free.
 *
 * Returns `null` for "free to proceed" so no caller can read "not frozen" as a
 * refusal.
 *
 * This is the ONLY answer to "is this Variant frozen by a Run?" in the tree. The
 * route layer reaches it through `repo.flags.liveRunUsingVariant` rather than
 * keeping its own environment-walking copy: two predicates for one question is
 * how SPL-118 drifted, and the copies had already diverged on whether
 * `runs.ended_at IS NULL` was part of "live".
 */
export async function liveRunUsingVariant(
  db: Db,
  scope: TenantScope,
  flagId: string,
  variant: VariantIdentity,
): Promise<VariantRunFreeze | null> {
  const running = await db
    .select({
      experimentId: experiments.id,
      environmentId: experiments.environmentId,
      liveRunId: experiments.liveRunId,
    })
    .from(experiments)
    .where(
      and(
        eq(experiments.appId, scope.appId),
        eq(experiments.flagId, flagId),
        eq(experiments.status, "running"),
      ),
    );

  for (const experiment of running) {
    const run = await liveRunForExperiment(db, scope, experiment.experimentId, variant);
    // A running Experiment with no resolvable live Run is a broken invariant,
    // not permission to rename. Refuse and name what is known (ADR-0036).
    if (run === "unresolvable") {
      return {
        experimentId: experiment.experimentId,
        environmentId: experiment.environmentId,
        runId: experiment.liveRunId ?? "unknown",
      };
    }
    if (run) {
      return {
        experimentId: experiment.experimentId,
        environmentId: experiment.environmentId,
        runId: run,
      };
    }
  }
  return null;
}

/**
 * The id of this Experiment's live Run when it allocates to the Variant, `null`
 * when it does not, and `"unresolvable"` when the Experiment claims to be
 * running but owns no live Run row at all.
 *
 * Matching is on Variant id OR name: the id catches the rename in flight, and
 * the name catches a Run frozen against a Variant row that has since been
 * replaced under the same name.
 */
async function liveRunForExperiment(
  db: Db,
  scope: TenantScope,
  experimentId: string,
  variant: VariantIdentity,
): Promise<string | null | "unresolvable"> {
  const live = await db
    .select({ id: runs.id, variantSet: runs.variantSet })
    .from(runs)
    .where(
      and(
        eq(runs.appId, scope.appId),
        eq(runs.experimentId, experimentId),
        eq(runs.status, "running"),
        sql`${runs.endedAt} IS NULL`,
      ),
    );
  if (live.length === 0) return "unresolvable";
  const owner = live.find((run) => variantSetReferences(run.variantSet, variant));
  return owner ? owner.id : null;
}

function variantSetReferences(rawVariantSet: string, variant: VariantIdentity): boolean {
  const parsed = JSON.parse(rawVariantSet) as Array<{ id?: string; name?: string }>;
  return parsed.some((candidate) => candidate.id === variant.id || candidate.name === variant.name);
}
