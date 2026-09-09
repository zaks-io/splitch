import type { ApprovalPolicyContext, PolicyChangeType } from "@splitch/contracts";
import { appScope, envScope, type Repository } from "@splitch/db";
import { approvalTargetVersion, environmentPolicyContexts } from "./approval-target";
import { buildSnapshotFromD1, responseFromSnapshot } from "./config-store-shared";
import type { FlagConfigResult } from "./config-store-types";
import { validationErrors } from "./flag-definition-errors";
import { flagConfigNotFound } from "./flag-config-errors";
import { readEnvironmentPolicy } from "./flag-config-policy";
import { targetConfigurationStale } from "./experiment-conclusion-errors";
import { winnerConfirmFloor } from "./experiment-conclusion-policy";
import {
  buildWinnerConfig,
  normalizedWinnerRules,
  validateSelectedVariant,
  type WinnerProposalInput,
  type WinnerTargetSnapshot,
} from "./experiment-conclusion-proposal-validation";
import { runFrozen } from "./experiment-errors";

export type PreparedWinnerProposal = {
  current: FlagConfigResult;
  proposed: FlagConfigResult;
  targetId: string;
  policyContexts: ApprovalPolicyContext[];
  policyGuardContexts: ApprovalPolicyContext[];
  targetVersion: `sha256:${string}`;
};

export async function prepareWinnerProposal(
  repo: Repository,
  input: WinnerProposalInput,
): Promise<{ ok: true; value: PreparedWinnerProposal } | { ok: false; response: Response }> {
  const loaded = await loadTarget(repo, input);
  if (!loaded.ok) return loaded;
  const selectedError = validateSelectedVariant(input, loaded.snapshot);
  if (selectedError) return selectedError;
  const rules = await normalizedWinnerRules(repo, input, loaded.current, loaded.snapshot);
  if (!rules.ok) return rules;
  const built = buildWinnerConfig(input, loaded.current, loaded.snapshot, rules.targetingRules);
  if (!built.ok) return built;
  const freezeError = await targetFreezeError(repo, input, loaded.snapshot, built.changeTypes);
  if (freezeError) return freezeError;
  const policy = await readEnvironmentPolicy(repo, input.appId, input.body.target.environmentId);
  if (!policy) return { ok: false, response: flagConfigNotFound(input.requestId) };
  const policyGuardContexts = environmentPolicyContexts(
    input.body.target.environmentId,
    policy,
    built.changeTypes,
  );
  const policyContexts = winnerConfirmFloor(policyGuardContexts);
  const targetVersion = await approvalTargetVersion(
    repo,
    input.appId,
    { type: "flag_configuration", id: loaded.targetId },
    policyContexts,
  );
  return {
    ok: true,
    value: {
      current: loaded.current,
      proposed: built.proposed,
      targetId: loaded.targetId,
      policyContexts,
      policyGuardContexts,
      targetVersion,
    },
  };
}

async function loadTarget(repo: Repository, input: WinnerProposalInput) {
  const target = input.body.target;
  if (target.flagId !== input.experimentFlagId) {
    return invalid(
      input.requestId,
      "target.flagId",
      "target Flag must be the Flag controlled by this Experiment",
    );
  }
  const environment = await repo.identity.getEnvironment(
    appScope(input.appId),
    target.environmentId,
  );
  if (!environment) return { ok: false as const, response: flagConfigNotFound(input.requestId) };
  const scope = envScope(input.appId, target.environmentId);
  const [snapshot, targetRow] = await Promise.all([
    buildSnapshotFromD1(repo, scope, target.flagId),
    repo.flags.getFlagConfig(scope, target.flagId),
  ]);
  if (!snapshot || !targetRow) {
    return { ok: false as const, response: flagConfigNotFound(input.requestId) };
  }
  const current = responseFromSnapshot(snapshot);
  if (current.version !== target.expectedConfigVersion) {
    return {
      ok: false as const,
      response: targetConfigurationStale(
        target.flagId,
        target.environmentId,
        target.expectedConfigVersion,
        current.version,
        input.requestId,
      ),
    };
  }
  return { ok: true as const, snapshot, current, targetId: targetRow.id };
}

async function targetFreezeError(
  repo: Repository,
  input: WinnerProposalInput,
  snapshot: WinnerTargetSnapshot,
  changeTypes: PolicyChangeType[],
) {
  const controlling = snapshot.controllingExperiment;
  if (
    !controlling ||
    (input.environmentId === input.body.target.environmentId &&
      controlling.id === input.experimentId)
  ) {
    return null;
  }
  const scope = envScope(input.appId, input.body.target.environmentId);
  const blocker = await repo.experiments.getExperiment(scope, controlling.id);
  if (!blocker?.liveRunId) {
    throw new Error("target Configuration names a controlling Experiment without a live Run");
  }
  return {
    ok: false as const,
    response: runFrozen(
      blocker.liveRunId,
      changeTypes,
      "CONCLUDE_RUN_WINNER_PROMOTION",
      input.requestId,
    ),
  };
}

function invalid(requestId: string, field: string, message: string) {
  return {
    ok: false as const,
    response: validationErrors(requestId, [{ path: ["body", ...field.split(".")], message }]),
  };
}
