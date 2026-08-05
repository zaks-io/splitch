import type {
  ResourceDeleteChildType,
  ResourceDeletePendingApproval,
  ResourceDeleteRemoved,
  ResourceDeleteResponse,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import {
  APP_FORCE_DELETE_ORDER,
  collectAppDeleteBlockers,
  flattenBlockerChildren,
} from "./app-delete-tree";
import {
  type AppEnvironmentDeps,
  type AppRow,
  type EnvironmentRow,
  nowIso,
} from "./app-environment-model";
import { makeOtherApprovalApplication } from "./approval-application";
import { createApproval } from "./approval-service";
import {
  configuredFlagEnvironments,
  environmentPolicyContexts,
  requiresReview,
} from "./approval-target";
import { deleteFlagD1Cascade, purgeFlagConfigsKvForFlag } from "./flag-config-lifecycle";

/**
 * App delete `--force` cascade (SPL-326).
 *
 * Walks the blocker tree in dependency order. Non-gated children are removed
 * through the same repository seams individual delete commands use. Policy-gated
 * Flag deletes create Approval Requests and STOP — force never auto-resolves
 * Reviews. Privacy ledger rows have no public delete API and are wiped only in
 * `finishForceDelete`, after every gated child is clear and the App is about to
 * die — never earlier in the phase loop (GDPR tombstones must survive a stop).
 */

export interface ForceDeleteAppResult {
  readonly response: ResourceDeleteResponse;
}

type Blockers = Awaited<ReturnType<typeof collectAppDeleteBlockers>>;

interface ForceState {
  blockers: Blockers;
  removed: ResourceDeleteRemoved[];
  pendingApprovals: ResourceDeletePendingApproval[];
}

export async function forceDeleteApp(
  deps: AppEnvironmentDeps,
  app: AppRow,
  environments: readonly EnvironmentRow[],
  principal: Principal,
  requestId: string,
  deleteAppRows: (
    deps: AppEnvironmentDeps,
    appId: string,
    environments: readonly EnvironmentRow[],
  ) => Promise<void>,
): Promise<ForceDeleteAppResult> {
  const state: ForceState = {
    blockers: await collectAppDeleteBlockers(deps, app, environments),
    removed: [],
    pendingApprovals: [],
  };

  for (const childType of APP_FORCE_DELETE_ORDER) {
    await runForcePhase(deps, app, principal, requestId, childType, state);
    state.blockers = await collectAppDeleteBlockers(
      deps,
      app,
      await deps.repo.identity.listEnvironments(appScope(app.id)),
    );
    if (state.pendingApprovals.length > 0) {
      return {
        response: {
          deleted: false,
          force: true,
          removed: state.removed,
          pendingApprovals: state.pendingApprovals,
        },
      };
    }
  }

  return finishForceDelete(deps, app, state.removed, deleteAppRows);
}

async function runForcePhase(
  deps: AppEnvironmentDeps,
  app: AppRow,
  principal: Principal,
  requestId: string,
  childType: ResourceDeleteChildType,
  state: ForceState,
): Promise<void> {
  switch (childType) {
    case "experiments":
      await forceDeleteExperiments(deps, app.id, state.blockers, principal, state.removed);
      return;
    case "segments":
      await forceDeleteByIds(
        state.blockers,
        "segments",
        (id) => deps.repo.flags.removeSegment(appScope(app.id), id),
        state.removed,
      );
      return;
    case "metrics":
      await forceDeleteByIds(
        state.blockers,
        "metrics",
        (id) => deps.repo.experiments.removeMetric(appScope(app.id), id),
        state.removed,
      );
      return;
    case "flags":
      await forceDeleteFlags(
        deps,
        app,
        principal,
        requestId,
        state.removed,
        state.pendingApprovals,
      );
      return;
    case "entity-privacy":
    case "privacy-requests":
      // Wiped only in finishForceDelete once the App is about to die.
      return;
    case "flag-config":
    case "flag-targeting-rules":
      // Cleared by flags_delete; orphans after Flag removal are impossible under FK-backed D1.
      return;
    default:
      return;
  }
}

async function finishForceDelete(
  deps: AppEnvironmentDeps,
  app: AppRow,
  removed: ResourceDeleteRemoved[],
  deleteAppRows: (
    deps: AppEnvironmentDeps,
    appId: string,
    environments: readonly EnvironmentRow[],
  ) => Promise<void>,
): Promise<ForceDeleteAppResult> {
  const liveEnvironments = await deps.repo.identity.listEnvironments(appScope(app.id));
  const remaining = await collectAppDeleteBlockers(deps, app, liveEnvironments);
  const nonPrivacy = remaining.filter(
    (blocker) => blocker.childType !== "entity-privacy" && blocker.childType !== "privacy-requests",
  );
  if (nonPrivacy.length > 0) {
    throw new Error(
      `apps delete --force left blockers after cascade: ${nonPrivacy
        .map((b) => `${b.childType}:${b.children.map((c) => c.id).join(",")}`)
        .join("; ")}`,
    );
  }

  // Privacy depends only on the App FK. Wipe it here — and only here — so a
  // confirm-policy stop cannot destroy tombstones on a live App.
  await wipePrivacyLedgerForAppDelete(deps, app, remaining, removed);

  await deleteAppRows(deps, app.id, liveEnvironments);
  removed.push({ childType: "apps", id: app.id });
  for (const environment of liveEnvironments) {
    removed.push({ childType: "environments", id: environment.id });
  }
  return { response: { deleted: true, force: true, removed } };
}

async function wipePrivacyLedgerForAppDelete(
  deps: AppEnvironmentDeps,
  app: AppRow,
  blockers: Blockers,
  removed: ResourceDeleteRemoved[],
): Promise<void> {
  const entityCount = await deps.repo.privacy.deleteEntityDeletionsForApp(appScope(app.id));
  if (entityCount > 0) {
    for (const child of flattenBlockerChildren(blockers, "entity-privacy")) {
      removed.push({ childType: "entity-privacy", id: child.id });
    }
  }
  const requestCount = await deps.repo.privacy.deletePrivacyRequestsForApp(
    app.organizationId,
    app.id,
  );
  if (requestCount > 0) {
    for (const child of flattenBlockerChildren(blockers, "privacy-requests")) {
      removed.push({ childType: "privacy-requests", id: child.id });
    }
  }
}

async function forceDeleteExperiments(
  deps: AppEnvironmentDeps,
  appId: string,
  blockers: Blockers,
  principal: Principal,
  removed: ResourceDeleteRemoved[],
): Promise<void> {
  for (const group of blockers.filter((b) => b.childType === "experiments")) {
    const scope = envScope(appId, group.resourceId);
    for (const child of group.children) {
      const archived = await deps.repo.experiments.archiveExperiment(scope, child.id, {
        updatedAt: nowIso(deps),
        updatedBy: principal.id,
      });
      if (archived > 0) {
        removed.push({ childType: "experiments", id: child.id });
      }
    }
  }
}

async function forceDeleteFlags(
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
  const body = (await approval.response.clone().json()) as {
    details?: { approvalRequestId?: string };
  };
  const approvalRequestId = body.details?.approvalRequestId;
  if (typeof approvalRequestId === "string") {
    return pendingApproval(app.id, approvalRequestId, flag.id);
  }
  throw new Error(`apps delete --force could not propose flags_delete for ${flag.id}`);
}

async function forceDeleteByIds(
  blockers: Blockers,
  childType: "segments" | "metrics",
  remove: (id: string) => Promise<unknown>,
  removed: ResourceDeleteRemoved[],
): Promise<void> {
  for (const child of flattenBlockerChildren(blockers, childType)) {
    await remove(child.id);
    removed.push({ childType, id: child.id });
  }
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
