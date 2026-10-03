import { assertMintedScope, type TenantScope } from "./scope";

/**
 * Auditable code-removal claim stored on the Flag deletion audit row.
 * Shape matches contracts `FlagCodeRemovalRecord`; kept local so @splitch/db
 * does not take a contracts dependency.
 */
export type FlagDeletionCodeRemovalRecord =
  | { state: "unknown" }
  | { state: "claimed"; reference: string };

/**
 * Attach the code-removal claim to the Flag deletion audit row the AFTER DELETE
 * trigger just wrote. Triggers cannot see the request body, so the Control Plane
 * patches `diff_json` only when it is still NULL (the trigger's sentinel).
 *
 * This is an auditable claim, not proof of repository removal.
 */
export function makeFlagDeletionCodeRemoval(d1: D1Database) {
  return {
    async recordCodeRemovalClaim(
      scope: TenantScope,
      flagId: string,
      codeRemoval: FlagDeletionCodeRemovalRecord,
    ): Promise<void> {
      assertMintedScope(scope);
      const diffJson = JSON.stringify({ codeRemoval });
      const result = await d1
        .prepare(
          `UPDATE flag_change_events
           SET diff_json = ?
           WHERE seq = (
             SELECT seq FROM (
               SELECT seq FROM flag_change_events
               WHERE app_id = ?
                 AND flag_id = ?
                 AND action = 'deleted'
                 AND target_type = 'flag'
                 AND environment_id IS NULL
                 AND diff_json IS NULL
               ORDER BY seq DESC
               LIMIT 1
             )
           )`,
        )
        .bind(diffJson, scope.appId, flagId)
        .run();
      if ((result.meta.changes ?? 0) !== 1) {
        throw new Error(
          `flag-deletion-code-removal: expected one NULL-diff deletion audit row for Flag ${flagId} in App ${scope.appId}, updated ${result.meta.changes ?? 0}`,
        );
      }
    },
  };
}
