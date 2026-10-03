import type { ApprovalRequest } from "@splitch/contracts";
import { type ApprovalCommit, appScope } from "@splitch/db";
import type { ApprovalApplicationDeps } from "./approval-application";
import { captureFlagConfigPurgeTargets, purgeFlagConfigsKvForKey } from "./flag-config-lifecycle";
import {
  codeRemovalRecordFromProposal,
  recordFlagDeletionCodeRemoval,
} from "./flag-deletion-code-removal";

/**
 * Deleting a Flag destroys every Environment's Configuration and targeting
 * rules for it. D1 goes first and is guarded by the Review, so a lost race
 * leaves KV untouched; purging KV first would leave a `confirm` Environment
 * unserved on a delete that never legally applied.
 */
export async function applyFlagDelete(
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
  const purgeTargets = await captureFlagConfigPurgeTargets(deps, request.appId, flagId);
  const deleted = await deps.repo.flags.deleteFlagCascade(
    appScope(request.appId),
    flagId,
    environments.map((environment) => environment.id),
    { approval: commit },
  );
  if (!deleted) {
    // Nothing applied; reconciliation decides stale vs recorded failure.
    return { ok: false as const, notApplied: true as const };
  }
  await recordFlagDeletionCodeRemoval(
    deps.repo,
    request.appId,
    flagId,
    codeRemovalRecordFromProposal(request.diff.proposed),
  );
  await purgeFlagConfigsKvForKey(deps, request.appId, flagId, flag.key, purgeTargets);
  return { ok: true as const };
}
