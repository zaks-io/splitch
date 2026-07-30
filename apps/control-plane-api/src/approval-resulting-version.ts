import {
  ApprovalDiffSchema,
  type ApprovalOperation,
  type ApprovalPolicyContext,
} from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";
import { absentVariantHint } from "./approval-row-target";
import type { ApprovalRequestRow } from "./approval-service-types";
import { absentTargetVersion, approvalTargetVersion } from "./approval-target";

export async function resultingVersionFor(
  repo: Repository,
  row: ApprovalRequestRow,
  operation: ApprovalOperation,
  contexts: ApprovalPolicyContext[],
  resultingResourceId: string,
) {
  if (isFlagConfigurationOperation(operation)) {
    return nextFlagConfigVersion(repo, row, contexts);
  }
  if (operation === "flag_variants_update") {
    return nextVariantVersion(repo, row, contexts);
  }
  if (operation === "flag_variants_create") {
    return createdVariantVersion(repo, row, contexts);
  }
  // A deleted Variant resolves to nothing, and "absent" is a version like any
  // other — the same token a later proposal against the dead id would compute.
  if (operation === "flag_variants_delete") {
    return absentTargetVersion({ type: "flag_variant", id: row.targetId });
  }
  // Same rule one level up: an applied Flag delete leaves nothing behind.
  if (operation === "flags_delete") {
    return absentTargetVersion({ type: "flag", id: row.targetId });
  }
  // An empty context list is a malformed row, not a missing Experiment. An
  // `envScope(appId, "")` would match nothing and report the two as one.
  const environmentId = contexts[0]?.environmentId;
  if (!environmentId) return null;
  const experiment = await repo.experiments.getExperiment(
    envScope(row.appId, environmentId),
    row.targetId,
  );
  if (!experiment) return null;
  const proposed = {
    ...ApprovalDiffSchema.parse(JSON.parse(row.diff)).proposed,
    liveRunId: resultingResourceId,
    draftAllocation: null,
    draftSalt: null,
    draftTargetingRules: null,
    draftSegmentIds: null,
  };
  return approvalTargetVersion(
    repo,
    row.appId,
    { type: "experiment_draft", id: row.targetId },
    contexts,
    { experiment: proposed },
  );
}

async function nextFlagConfigVersion(
  repo: Repository,
  row: ApprovalRequestRow,
  contexts: ApprovalPolicyContext[],
) {
  const environmentId = contexts[0]?.environmentId;
  if (!environmentId) return null;
  const config = await repo.flags.getFlagConfigById(
    envScope(row.appId, environmentId),
    row.targetId,
  );
  return config
    ? approvalTargetVersion(
        repo,
        row.appId,
        { type: "flag_configuration", id: row.targetId },
        contexts,
        { flagConfigVersion: config.version + 1 },
      )
    : null;
}

async function nextVariantVersion(
  repo: Repository,
  row: ApprovalRequestRow,
  contexts: ApprovalPolicyContext[],
) {
  const variant = await repo.flags.getVariantById(appScope(row.appId), row.targetId);
  const flag = variant ? await repo.flags.getFlag(appScope(row.appId), variant.flagId) : null;
  if (!(variant && flag)) return null;
  const proposedName = ApprovalDiffSchema.parse(JSON.parse(row.diff)).proposed.name;
  const renamed = typeof proposedName === "string" && proposedName !== variant.name;
  return approvalTargetVersion(
    repo,
    row.appId,
    { type: "flag_variant", id: row.targetId },
    contexts,
    { flagVersion: flag.version + 1, ...(renamed ? { renamedFrom: variant.name } : {}) },
  );
}

async function createdVariantVersion(
  repo: Repository,
  row: ApprovalRequestRow,
  contexts: ApprovalPolicyContext[],
) {
  const hint = absentVariantHint(row.operation, row.diff);
  if (!hint) return null;
  const flag = await repo.flags.getFlag(appScope(row.appId), hint.absentVariant.flagId);
  if (!flag) return null;
  return approvalTargetVersion(
    repo,
    row.appId,
    { type: "flag_variant", id: row.targetId },
    contexts,
    {
      ...hint,
      flagVersion: flag.version + 1,
    },
  );
}

/**
 * The operations whose target is a Flag Configuration. Exported so the
 * application path classifies operations through the same predicate the
 * resulting-version path does; two copies drift the moment an operation is
 * added.
 */
export function isFlagConfigurationOperation(operation: ApprovalOperation): boolean {
  return (
    operation === "flag_config_update" ||
    operation === "flag_targeting_rules_replace" ||
    operation === "flags_promote"
  );
}
