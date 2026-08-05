import type { ResourceDeletePendingApproval, ResourceDeleteRemoved } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import type { AppEnvironmentDeps, AppRow } from "./app-environment-model";
import { makeOtherApprovalApplication } from "./approval-application";
import { createApproval } from "./approval-service";
import {
  configuredFlagEnvironments,
  environmentPolicyContexts,
  requiresReview,
} from "./approval-target";
import { deleteFlagD1Cascade, purgeFlagConfigsKvForFlag } from "./flag-config-lifecycle";

/** Force-path Flag deletes: Policy-gated proposals stop the cascade (SPL-326). */

export async function forceDeleteFlags(
  deps: AppEnvironmentDeps,
  app: AppRow,
  principal: Principal,
  requestId: string,
  removed: ResourceDeleteRemoved[],
  pendingApprovals: ResourceDeletePendingApproval[],
): Promise<void> {
  const flags = await deps.repo.flags.flags.findMany(appScope(app.id));
  for (const flag of flags) {
    const gated = await proposeFlagDeleteIfGated(deps, app, flag, principal, requestId);
    if (gated) {
      pendingApprovals.push(gated);
      continue;
    }
    await purgeFlagConfigsKvForFlag(deps, app.id, flag.id);
    await deleteFlagD1Cascade(deps, app.id, flag.id);
    removed.push({ childType: "flags", id: flag.id });
  }
}

async function proposeFlagDeleteIfGated(
  deps: AppEnvironmentDeps,
  app: AppRow,
  flag: { id: string; key: string; name: string; version: number },
  principal: Principal,
  requestId: string,
): Promise<ResourceDeletePendingApproval | null> {
  const configured = await configuredFlagEnvironments(deps.repo, app.id, flag.id);
  const contexts = configured.flatMap((environment) =>
    environmentPolicyContexts(environment.environmentId, environment.policy, [
      "variant_availability",
    ]),
  );
  if (!requiresReview(contexts)) return null;

  // Stable per (app, flag) so a premature --force retry replays the same
  // pending Approval Request instead of minting a duplicate (SPL-326 author QA).
  const idempotencyKey = `apps_delete_force_${app.id}_${flag.id}`;
  const approval = await createApproval(
    { ...deps, applyOther: makeOtherApprovalApplication(deps) },
    {
      appId: app.id,
      operation: "flags_delete",
      target: { type: "flag", id: flag.id },
      policyContexts: contexts,
      current: {
        flagId: flag.id,
        key: flag.key,
        name: flag.name,
        version: flag.version,
      },
      proposed: {},
      proposalInput: { flagId: flag.id },
      principal,
      idempotencyKey,
      inlineReview: false,
      requestId,
    },
  );
  if (approval.ok) {
    // Applied replay: Flag delete already took effect; caller removes any remnant.
    return null;
  }
  return pendingApprovalFromFailedCreate(
    deps,
    app,
    flag.id,
    principal.id,
    idempotencyKey,
    approval.response,
  );
}

async function pendingApprovalFromFailedCreate(
  deps: AppEnvironmentDeps,
  app: AppRow,
  flagId: string,
  principalId: string,
  idempotencyKey: string,
  response: Response,
): Promise<ResourceDeletePendingApproval> {
  const body = (await response.clone().json()) as {
    code?: string;
    details?: { approvalRequestId?: string };
  };
  if (
    body.code === "APPROVAL_REVIEW_REQUIRED" &&
    typeof body.details?.approvalRequestId === "string"
  ) {
    return pendingApproval(app.id, body.details.approvalRequestId, flagId);
  }
  if (body.code === "IDEMPOTENCY_KEY_CONFLICT") {
    const existing = await deps.repo.approvals.getRequestByActorKey(
      appScope(app.id),
      principalId,
      idempotencyKey,
    );
    if (existing?.status === "pending" && existing.targetId === flagId) {
      return pendingApproval(app.id, existing.id, flagId);
    }
    throw new Error(
      `apps delete --force idempotency conflict for flags_delete ${flagId} (key ${idempotencyKey})`,
    );
  }
  throw new Error(
    `apps delete --force could not propose flags_delete for ${flagId}${
      body.code ? ` (${body.code})` : ""
    }`,
  );
}

function pendingApproval(
  appId: string,
  approvalRequestId: string,
  targetId: string,
): ResourceDeletePendingApproval {
  const body = JSON.stringify({
    action: "approve_and_apply",
    idempotency_key: `cli_force_review_${approvalRequestId}`,
  });
  return {
    approvalRequestId,
    operation: "flags_delete",
    targetId,
    reviewCommand: `splitch approval-request-reviews create --app ${appId} ${approvalRequestId} --body-json '${body}'`,
  };
}
