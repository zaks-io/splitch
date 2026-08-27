import type { ApprovalRequest } from "@splitch/contracts";
import { type ApprovalCommit, appScope, type Repository } from "@splitch/db";
import { applyExperimentStart } from "./approval-application-experiment-start";
import type { ApplicationOutcome } from "./approval-service-types";
import type { ConfigStoreAccess } from "./config-store-do";
import { purgeFlagConfigsKvForKey } from "./flag-config-lifecycle";
import {
  type VariantDeleteRefusal,
  type VariantWriteRefusal,
  variantFreezeDetails,
  variantFreezeMessage,
  variantTargetingRuleReferenceDetails,
  variantTargetingRuleReferenceMessage,
} from "./flag-definition-errors";
import { targetingRulesReferencingVariant } from "./flag-definition-guards";
import { resyncFlagSnapshots } from "./flag-definition-handler-utils";
import type { RunSnapshotDelivery } from "./run-snapshot";
import { republishApplicationError } from "./segment-republication";
import { applyApprovedSegmentUpdate } from "./segment-update";

export interface ApprovalApplicationDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  runSnapshotDelivery?: RunSnapshotDelivery;
  nowIso?: () => string;
}

export function makeOtherApprovalApplication(deps: ApprovalApplicationDeps) {
  return async (request: ApprovalRequest, commit: ApprovalCommit): Promise<ApplicationOutcome> => {
    const variant = await applyVariantOperation(deps, request, commit);
    if (variant) return variant;
    if (request.operation === "flags_delete") {
      return applyFlagDelete(deps, request, commit);
    }
    if (request.operation === "segments_update") {
      return applySegmentUpdate(deps, request, commit);
    }
    if (request.operation === "experiments_start") {
      return applyExperimentStart(deps, request, commit);
    }
    // No branch claimed this operation, so nothing ran against a target.
    return {
      ok: false,
      targetState: "rolled_back",
      error: { code: "INTERNAL_SERVER_ERROR", details: {} },
    };
  };
}

async function applyVariantOperation(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
): Promise<ApplicationOutcome | null> {
  if (request.operation === "flag_variants_update") return applyVariant(deps, request, commit);
  if (request.operation === "flag_variants_create")
    return applyVariantCreate(deps, request, commit);
  if (request.operation === "flag_variants_delete")
    return applyVariantDelete(deps, request, commit);
  return null;
}

async function applySegmentUpdate(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
): Promise<ApplicationOutcome> {
  const segment = await deps.repo.flags.getSegment(appScope(request.appId), request.target.id);
  if (!segment) {
    return {
      ok: false,
      targetState: "rolled_back",
      error: {
        code: "SEGMENT_NOT_FOUND",
        details: { missingSegmentIds: [request.target.id] },
      },
    };
  }
  const result = await applyApprovedSegmentUpdate(
    deps,
    request.appId,
    segment,
    request.diff.proposed,
    commit,
  );
  if (result.ok) return { ok: true };
  if ("notApplied" in result) return { ok: false, notApplied: true };
  if ("republishFailure" in result) {
    const failure = republishApplicationError(result.republishFailure);
    // `segmentApplied` is the same fact the Review message needs: the Segment
    // mutation is written before republication runs, so a fan-out failure past
    // that point leaves the Conditions durable in D1 and must not be reported
    // as a rollback.
    return {
      ok: false,
      targetState: result.republishFailure.segmentApplied ? "applied" : "rolled_back",
      error: { code: failure.code, details: failure.details },
    };
  }
  return {
    ok: false,
    targetState: "rolled_back",
    error: {
      code: "VALIDATION_ERROR",
      details: { field: "diff.proposed", reason: "MALFORMED_APPROVAL_PROPOSAL" },
    },
  };
}

async function applyVariant(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  const proposed = request.diff.proposed;
  const variant = await deps.repo.flags.getVariantById(appScope(request.appId), request.target.id);
  if (!variant || typeof proposed.flagId !== "string" || proposed.flagId !== variant.flagId) {
    return {
      ok: false as const,
      targetState: "rolled_back" as const,
      error: { code: "VARIANT_NOT_FOUND" as const, details: {} },
    };
  }
  if (typeof proposed.name !== "string") return malformedProposal("name");
  if (proposed.value === undefined) return malformedProposal("value");
  const updated = await deps.repo.flags.updateVariant(
    appScope(request.appId),
    variant.flagId,
    variant.name,
    {
      name: proposed.name,
      value: JSON.stringify(proposed.value),
      description: typeof proposed.description === "string" ? proposed.description : null,
    },
    {
      updatedAt: commit.reviewedAt,
      updatedBy: commit.reviewedBy,
      approval: commit,
    },
  );
  // A proposal filed BEFORE a Run started and approved AFTER it is the second
  // door onto this mutation — for the name AND for the value — and the same
  // repository seam refuses both. A value swap landing here is the quieter of
  // the two: it would return `applied`, republish KV, and leave the live Run
  // serving the same arm name with a different payload, so the analysis
  // population mixes two treatments with no error anywhere. The refusal is
  // recorded on the Review as a machine-stable reason rather than swallowed as
  // `notApplied`, which reads as a lost race worth retrying — a retry that can
  // never succeed while the Run lives (ADR-0036: no impossible remedy).
  if (!updated.ok) return variantApplicationRefusal(updated);
  await resyncFlagSnapshots(deps, request.appId, variant.flagId);
  return { ok: true as const };
}

/**
 * The sibling of `variantWriteRefusal` on the direct route: every reason gets an
 * outcome, and the outcomes stay DISTINCT. `NOT_FOUND` used to be swallowed by
 * the `notApplied` catch-all, which reads as a lost race worth another Review —
 * a retry that can never find a Variant that no longer exists (ADR-0036).
 *
 * `RUN_FROZEN` and `NOT_FOUND` resolve as `unapplicable`, not `error`. Both
 * describe a world that moved after the proposal was minted and cannot move back
 * on a reviewer's say-so, so the Request resolves terminally instead of parking
 * as `pending` behind a `RETRY_REVIEW` that can never succeed. `configFailure`
 * in `approval-review-application.ts` already makes exactly this ruling for the
 * Flag Configuration path, and the two must agree: one trigger, one Request
 * status, whichever door the write came through.
 */
export function variantApplicationRefusal(refusal: VariantWriteRefusal): ApplicationOutcome {
  switch (refusal.reason) {
    // A proposal filed BEFORE a Run started and approved AFTER it is the second
    // door onto this mutation — for the name AND for the value — and the same
    // repository seam refuses both. A value swap landing here is the quieter of
    // the two: it would return `applied`, republish KV, and leave the live Run
    // serving the same arm name with a different payload, so the analysis
    // population mixes two treatments with no error anywhere.
    case "RUN_FROZEN":
      return {
        ok: false,
        unapplicable: {
          code: "RUN_FROZEN" as const,
          message: variantFreezeMessage(refusal),
          details: variantFreezeDetails(refusal),
        },
      };
    // The Variant was read at the top of `applyVariant`, so this is a concurrent
    // delete between that read and the guarded write. A deleted Variant does not
    // come back, so the proposal is as terminal as the frozen one.
    case "NOT_FOUND":
      return {
        ok: false,
        unapplicable: {
          code: "VARIANT_NOT_FOUND" as const,
          message: "the Variant this proposal targets no longer exists",
          details: {},
        },
      };
    // The guarded write selected zero rows: reconciliation decides stale vs
    // resolved.
    case "NOT_APPLIED":
      return notApplied();
    default:
      return unhandledRefusal(refusal);
  }
}

/** A reason added to the union without an outcome must not resolve as applied. */
function unhandledRefusal(refusal: never): never {
  throw new Error(`unhandled updateVariant refusal: ${JSON.stringify(refusal)}`);
}

async function applyVariantCreate(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  const proposed = request.diff.proposed;
  const flagId = proposed.flagId;
  if (typeof flagId !== "string") return malformedProposal("flagId");
  if (typeof proposed.name !== "string") return malformedProposal("name");
  if (proposed.value === undefined) return malformedProposal("value");
  const created = await deps.repo.flags.addVariant(
    appScope(request.appId),
    flagId,
    {
      id: request.target.id,
      name: proposed.name,
      value: JSON.stringify(proposed.value),
      ...(typeof proposed.description === "string" ? { description: proposed.description } : {}),
      createdAt: commit.reviewedAt,
    },
    { updatedAt: commit.reviewedAt, updatedBy: commit.reviewedBy, approval: commit },
  );
  if (!created) return notApplied();
  await resyncFlagSnapshots(deps, request.appId, flagId);
  return { ok: true as const };
}

async function applyVariantDelete(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  const variant = await deps.repo.flags.getVariantById(appScope(request.appId), request.target.id);
  if (!variant) {
    return {
      ok: false as const,
      targetState: "rolled_back" as const,
      error: { code: "VARIANT_NOT_FOUND" as const, details: {} },
    };
  }
  // Fail-fast only. `removeVariant` is the seam that actually refuses when a
  // Targeting Rule exists at write time; this read cannot close the race
  // between listing and the DELETE (`targeting_rules.variant_id` has no FK).
  const envs = await deps.repo.identity.listEnvironments(appScope(request.appId));
  const targetingRules = await targetingRulesReferencingVariant(
    deps.repo,
    request.appId,
    variant.flagId,
    variant.id,
    envs,
  );
  if (targetingRules.length > 0) {
    return variantDeleteApplicationRefusal({
      ok: false,
      reason: "TARGETING_RULE_REFS",
      variantName: variant.name,
      targetingRules,
    });
  }
  const removed = await deps.repo.flags.removeVariant(
    appScope(request.appId),
    variant.flagId,
    variant.name,
    { updatedAt: commit.reviewedAt, updatedBy: commit.reviewedBy, approval: commit },
  );
  if (!removed.ok) return variantDeleteApplicationRefusal(removed);
  await resyncFlagSnapshots(deps, request.appId, variant.flagId);
  return { ok: true as const };
}

/** The delete sibling of `variantApplicationRefusal`. */
export function variantDeleteApplicationRefusal(refusal: VariantDeleteRefusal): ApplicationOutcome {
  switch (refusal.reason) {
    case "TARGETING_RULE_REFS":
      return {
        ok: false,
        unapplicable: {
          code: "RESOURCE_NOT_EMPTY" as const,
          message: variantTargetingRuleReferenceMessage(refusal),
          details: variantTargetingRuleReferenceDetails(refusal),
        },
      };
    case "NOT_FOUND":
      return {
        ok: false,
        targetState: "rolled_back",
        error: { code: "VARIANT_NOT_FOUND" as const, details: {} },
      };
    case "NOT_APPLIED":
      return notApplied();
    default:
      return unhandledDeleteRefusal(refusal);
  }
}

function unhandledDeleteRefusal(refusal: never): never {
  throw new Error(`unhandled removeVariant refusal: ${JSON.stringify(refusal)}`);
}

/**
 * Deleting a Flag destroys every Environment's Configuration and targeting
 * rules for it. D1 goes first and is guarded by the Review, so a lost race
 * leaves KV untouched; purging KV first would leave a `confirm` Environment
 * unserved on a delete that never legally applied.
 */
async function applyFlagDelete(
  deps: ApprovalApplicationDeps,
  request: ApprovalRequest,
  commit: ApprovalCommit,
) {
  const flagId = request.target.id;
  const flag = await deps.repo.flags.getFlag(appScope(request.appId), flagId);
  if (!flag) {
    return {
      ok: false as const,
      targetState: "rolled_back" as const,
      error: { code: "FLAG_NOT_FOUND" as const, details: {} },
    };
  }
  const environments = await deps.repo.identity.listEnvironments(appScope(request.appId));
  const deleted = await deps.repo.flags.deleteFlagCascade(
    appScope(request.appId),
    flagId,
    environments.map((environment) => environment.id),
    { approval: commit },
  );
  if (!deleted) return notApplied();
  await purgeFlagConfigsKvForKey(deps, request.appId, flagId, flag.key);
  return { ok: true as const };
}

/**
 * The Approval-guarded write selected zero rows: nothing was applied, and the
 * reconciliation re-reads the stored state to decide `stale` vs a recorded
 * failure. Reporting it as a failure here would bury a legitimate race.
 */
function notApplied() {
  return { ok: false as const, notApplied: true as const };
}

/**
 * A stored proposal that cannot be read is a recorded application failure, not
 * a thrown exception: every other branch here returns `{ ok: false, error }` so
 * the Review row keeps a machine-stable reason, and a throw would instead land
 * as an anonymous INTERNAL_SERVER_ERROR through the catch in
 * `approval-review-application.ts`.
 */
function malformedProposal(field: string) {
  return {
    ok: false as const,
    targetState: "rolled_back" as const,
    error: {
      code: "VALIDATION_ERROR" as const,
      details: { field, reason: "MALFORMED_APPROVAL_PROPOSAL" },
    },
  };
}
