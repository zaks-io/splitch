import {
  EnvironmentPolicySchema,
  type EnvironmentPolicy,
  type PolicyChangeType,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import type { ConfigStoreWriter } from "./config-store";

type PromotionSelect = Parameters<ConfigStoreWriter["promoteFlagConfig"]>[0]["select"];

export async function readEnvironmentPolicy(
  repo: Repository,
  appId: string,
  environmentId: string,
): Promise<EnvironmentPolicy | null> {
  const row = await repo.identity.getEnvironment(appScope(appId), environmentId);
  return row ? EnvironmentPolicySchema.parse(JSON.parse(row.policy)) : null;
}

export function flagConfigPatchGates(payload: Record<string, unknown>): PolicyChangeType[] {
  const gates: PolicyChangeType[] = [];
  if (payload.availableVariantNames !== undefined) gates.push("variant_availability");
  // The baseline rollout is a rollout VALUE, so it falls under the same gate the
  // per-rule rollout does — a prod percentage change is not a free action.
  if (payload.rollout !== undefined) gates.push("targeting_rollout_value");
  if (payload.enabled === true) gates.push("enabled_state");
  return gates;
}

export function promotionGates(
  select: PromotionSelect,
  sourceEnabled: boolean,
): PolicyChangeType[] {
  const gates: PolicyChangeType[] = [];
  if (select.availability !== undefined) gates.push("variant_availability");
  if (select.targeting || select.rollout) gates.push("targeting_rollout_value");
  if (select.enabled && sourceEnabled) gates.push("enabled_state");
  return gates;
}

export function confirmationRequired(
  policy: EnvironmentPolicy,
  gates: PolicyChangeType[],
  confirmed: boolean,
  environmentId: string,
  attemptedOp: string,
  requestId: string,
): Response | null {
  const gate = gates.find((candidate) => policyLevel(policy, candidate) === "confirm");
  if (!gate || confirmed) return null;

  return renderError(
    {
      code: "CONFIRMATION_REQUIRED",
      message: "confirmation required by Environment Policy",
      details: {
        gate,
        environmentId,
        attemptedOp,
        recommendedAction: "RETRY_WITH_CONFIRMATION",
      },
    },
    { requestId },
  );
}

function policyLevel(policy: EnvironmentPolicy, gate: PolicyChangeType) {
  switch (gate) {
    case "variant_availability":
      return policy.variantAvailability;
    case "targeting_rollout_value":
      return policy.targetingRolloutValue;
    case "enabled_state":
      return policy.enabledState;
    case "start_experiment_run":
      return policy.startExperimentRun;
  }
}
