import {
  ApprovalDiffSchema,
  type ApprovalOperation,
  type ApprovalPolicyContext,
} from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";
import type { ApprovalRequestRow } from "./approval-service-types";
import { approvalTargetVersion } from "./approval-target";

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
  const experiment = await repo.experiments.getExperiment(
    envScope(row.appId, contexts[0]?.environmentId ?? ""),
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
  return flag
    ? approvalTargetVersion(repo, row.appId, { type: "flag_variant", id: row.targetId }, contexts, {
        flagVersion: flag.version + 1,
      })
    : null;
}

function isFlagConfigurationOperation(operation: ApprovalOperation): boolean {
  return (
    operation === "flag_config_update" ||
    operation === "flag_targeting_rules_replace" ||
    operation === "flags_promote"
  );
}
