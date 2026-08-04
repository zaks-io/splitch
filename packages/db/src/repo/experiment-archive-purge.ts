import { assertMintedScope, type EnvScope } from "./scope";

/**
 * Parent teardown (Environment / App delete) hard-deletes archived Experiment
 * rows and their retained Runs. Experiment-level DELETE only archives; Flag
 * delete folds the same purge into `deleteFlagCascade`'s Approval-guarded
 * batch so a declined Review cannot destroy retained rows.
 */

export function makePurgeArchivedExperimentsInEnvironment(d1: D1Database) {
  return async function purgeArchivedExperimentsInEnvironment(scope: EnvScope): Promise<void> {
    assertMintedScope(scope);
    const scopeParams = [scope.appId, scope.environmentId] as const;
    await d1.batch([
      d1
        .prepare(
          `DELETE FROM runs
           WHERE app_id = ? AND environment_id = ?
             AND experiment_id IN (
               SELECT id FROM experiments
               WHERE app_id = ? AND environment_id = ? AND status = 'archived'
             )`,
        )
        .bind(...scopeParams, ...scopeParams),
      d1
        .prepare(
          `DELETE FROM experiments
           WHERE app_id = ? AND environment_id = ? AND status = 'archived'`,
        )
        .bind(...scopeParams),
    ]);
  };
}
