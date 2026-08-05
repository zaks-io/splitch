import type {
  ResourceDeleteChildType,
  ResourceDeletePendingApproval,
  ResourceDeleteRemoved,
  ResourceDeleteResponse,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { forceDeleteFlags } from "./app-delete-force-flags";
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

/**
 * App delete `--force` cascade (SPL-326).
 *
 * Walks blockers in dependency order. Non-gated children use the same repo
 * seams as individual deletes. Policy-gated Flag deletes create Approval
 * Requests and STOP. Privacy ledger rows wipe only inside `deleteAppCascade`'s
 * atomic batch so a late FK failure cannot destroy tombstones on a live App.
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

/** Phases that only re-read an already-cleared child type — no tree refresh. */
const NOOP_FORCE_PHASES = new Set<ResourceDeleteChildType>([
  "flag-config",
  "flag-targeting-rules",
  "entity-privacy",
  "privacy-requests",
]);

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
  /** Pre-collected blockers from the handler (avoids a duplicate inventory). */
  initialBlockers?: Blockers,
): Promise<ForceDeleteAppResult> {
  const state: ForceState = {
    blockers: initialBlockers ?? (await collectAppDeleteBlockers(deps, app, environments)),
    removed: [],
    pendingApprovals: [],
  };

  for (const childType of APP_FORCE_DELETE_ORDER) {
    await runForcePhase(deps, app, principal, requestId, childType, state);
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
    if (NOOP_FORCE_PHASES.has(childType)) {
      continue;
    }
    // Mutating phases: refresh so later phases see current children. Flags use
    // live finds; segments/metrics read from this tree.
    state.blockers = await collectAppDeleteBlockers(
      deps,
      app,
      await deps.repo.identity.listEnvironments(appScope(app.id)),
    );
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
    case "entity-privacy":
    case "privacy-requests":
    case "flag-config":
    case "flag-targeting-rules":
      // Privacy: wiped atomically in deleteAppCascade. Flag configs/rules: cleared
      // by flags_delete; orphans after Flag removal are impossible under FK-backed D1.
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

  // Record privacy removals from the inventory, then delete App + privacy in one
  // D1 batch. Never wipe the ledger in a separate statement before deleteAppRows.
  for (const child of flattenBlockerChildren(remaining, "entity-privacy")) {
    removed.push({ childType: "entity-privacy", id: child.id });
  }
  for (const child of flattenBlockerChildren(remaining, "privacy-requests")) {
    removed.push({ childType: "privacy-requests", id: child.id });
  }

  await deleteAppRows(deps, app.id, liveEnvironments);
  removed.push({ childType: "apps", id: app.id });
  for (const environment of liveEnvironments) {
    removed.push({ childType: "environments", id: environment.id });
  }
  return { response: { deleted: true, force: true, removed } };
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
