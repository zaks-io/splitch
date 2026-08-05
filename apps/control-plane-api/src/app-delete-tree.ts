import type {
  ResourceDeleteBlocker,
  ResourceDeleteChild,
  ResourceDeleteChildType,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { AppEnvironmentDeps, AppRow, EnvironmentRow } from "./app-environment-model";

/**
 * Full App-delete blocker inventory (SPL-326).
 *
 * Returns every non-cascaded child in dependency-friendly order, naming each
 * child by ID and by the CLI command that removes it. Storage table names never
 * appear as `childType` — agents get CLI vocabulary (`flag-config`, not
 * `flag_configs`).
 */

export async function collectAppDeleteBlockers(
  deps: AppEnvironmentDeps,
  app: AppRow,
  environments: readonly EnvironmentRow[],
): Promise<ResourceDeleteBlocker[]> {
  const blockers: ResourceDeleteBlocker[] = [];
  for (const environment of environments) {
    blockers.push(...(await collectEnvironmentDeleteBlockers(deps, app.id, environment.id)));
  }
  blockers.push(...(await collectAppScopedDeleteBlockers(deps, app)));
  return blockers;
}

export async function collectEnvironmentDeleteBlockers(
  deps: AppEnvironmentDeps,
  appId: string,
  environmentId: string,
): Promise<ResourceDeleteBlocker[]> {
  const scope = envScope(appId, environmentId);
  const blockers: ResourceDeleteBlocker[] = [];

  const experimentRows = await deps.repo.experiments.experiments.findMany(scope);
  const activeExperiments = experimentRows.filter((row) => row.status !== "archived");
  if (activeExperiments.length > 0) {
    blockers.push(
      blocker("environment", environmentId, "experiments", activeExperiments, (id) =>
        command(`experiments delete --app ${appId} --env ${environmentId} ${id}`),
      ),
    );
  }

  const flagConfigs = await deps.repo.flags.flagConfigs.findMany(scope);
  if (flagConfigs.length > 0) {
    blockers.push({
      resourceType: "environment",
      resourceId: environmentId,
      childType: "flag-config",
      children: flagConfigs.map((row) => ({
        id: row.id,
        removeCommand: command(`flags delete --app ${appId} ${row.flagId}`),
      })),
    });
  }

  const targetingRules = await deps.repo.flags.targetingRules.findMany(scope);
  if (targetingRules.length > 0) {
    blockers.push({
      resourceType: "environment",
      resourceId: environmentId,
      childType: "flag-targeting-rules",
      children: targetingRules.map((row) => ({
        id: row.id,
        removeCommand: command(`flags delete --app ${appId} ${row.flagId}`),
      })),
    });
  }

  return blockers;
}

async function collectAppScopedDeleteBlockers(
  deps: AppEnvironmentDeps,
  app: AppRow,
): Promise<ResourceDeleteBlocker[]> {
  const scope = appScope(app.id);
  const blockers: ResourceDeleteBlocker[] = [];

  const flags = await deps.repo.flags.flags.findMany(scope);
  if (flags.length > 0) {
    blockers.push(
      blocker("app", app.id, "flags", flags, (id) => command(`flags delete --app ${app.id} ${id}`)),
    );
  }

  const segments = await deps.repo.flags.segments.findMany(scope);
  if (segments.length > 0) {
    blockers.push(
      blocker("app", app.id, "segments", segments, (id) =>
        command(`segments delete --app ${app.id} ${id}`),
      ),
    );
  }

  const metrics = await deps.repo.experiments.metrics.findMany(scope);
  if (metrics.length > 0) {
    blockers.push(
      blocker("app", app.id, "metrics", metrics, (id) =>
        command(`metrics delete --app ${app.id} ${id}`),
      ),
    );
  }

  const entityDeletions = await deps.repo.privacy.listEntityDeletions(scope);
  if (entityDeletions.length > 0) {
    blockers.push(
      blocker(
        "app",
        app.id,
        "entity-privacy",
        entityDeletions.map((row) => ({
          id: `${row.idType}:${row.targetingKeyHash}:${row.deleteBeforeTs}`,
        })),
        () => command(`apps delete --app ${app.id} --force`),
      ),
    );
  }

  const privacyRequests = await deps.repo.privacy.listPrivacyRequestsForApp(
    app.organizationId,
    app.id,
  );
  if (privacyRequests.length > 0) {
    blockers.push(
      blocker(
        "app",
        app.id,
        "privacy-requests",
        privacyRequests.map((row) => ({ id: row.requestId })),
        () => command(`apps delete --app ${app.id} --force`),
      ),
    );
  }

  return blockers;
}

function blocker(
  resourceType: ResourceDeleteBlocker["resourceType"],
  resourceId: string,
  childType: ResourceDeleteChildType,
  rows: ReadonlyArray<{ id: string } & Record<string, unknown>>,
  removeCommand: (id: string, row: { id: string } & Record<string, unknown>) => string,
): ResourceDeleteBlocker {
  const children: ResourceDeleteChild[] = rows.map((row) => ({
    id: row.id,
    removeCommand: removeCommand(row.id, row),
  }));
  return { resourceType, resourceId, childType, children };
}

function command(rest: string): string {
  return `splitch ${rest}`;
}

/** Stable dependency order for `--force` removals (children before App cascade).
 *
 * Privacy ledger rows (`entity-privacy`, `privacy-requests`) are intentionally
 * absent: they depend only on the App FK and must not be wiped until
 * `finishForceDelete` — otherwise a confirm-policy Flag stop would destroy
 * GDPR tombstones on a delete that never happens (SPL-326 security audit).
 */
export const APP_FORCE_DELETE_ORDER: readonly ResourceDeleteChildType[] = [
  "experiments",
  "segments",
  "metrics",
  "flags",
  "flag-config",
  "flag-targeting-rules",
] as const;

export function flattenBlockerChildren(
  blockers: readonly ResourceDeleteBlocker[],
  childType: ResourceDeleteChildType,
): ResourceDeleteChild[] {
  return blockers
    .filter((entry) => entry.childType === childType)
    .flatMap((entry) => entry.children);
}
