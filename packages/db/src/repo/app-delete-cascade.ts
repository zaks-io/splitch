import { assertMintedScope, type TenantScope } from "./scope";

/**
 * Atomic App teardown (SPL-298).
 *
 * App delete previously removed Environments, credentials, and App memberships
 * as separate D1 statements, then deleted the App row last. When a leftover
 * child (notably `approval_requests`) made the final DELETE fail under FK
 * enforcement, memberships were already gone: org-scoped reads still listed the
 * App, but every app-scoped grant and route failed live-membership checks.
 *
 * `d1.batch` is the transaction boundary. Credentials, Environments, memberships,
 * and the App row commit together or not at all. Callers must still refuse
 * non-cascaded children (flags, Approval Requests, …) before invoking this; the
 * batch is the last line of defense against a partial cascade, not a substitute
 * for the emptiness guard.
 *
 * Archived Experiment + Run rows are purged here (same SQL as Environment
 * teardown) so Environment FKs can clear once only archived rows remain.
 */

export function makeDeleteAppCascade(d1: D1Database) {
  return async function deleteAppCascade(scope: TenantScope): Promise<void> {
    assertMintedScope(scope);
    const appId = scope.appId;
    const results = await d1.batch([
      d1
        .prepare(
          `DELETE FROM runs
           WHERE app_id = ?
             AND experiment_id IN (
               SELECT id FROM experiments
               WHERE app_id = ? AND status = 'archived'
             )`,
        )
        .bind(appId, appId),
      d1.prepare(`DELETE FROM experiments WHERE app_id = ? AND status = 'archived'`).bind(appId),
      d1.prepare(`DELETE FROM api_keys WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM client_keys WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM environments WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM app_memberships WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM apps WHERE id = ? RETURNING id`).bind(appId),
    ]);
    if ((results[results.length - 1]?.results ?? []).length !== 1) {
      throw new Error("app delete did not reach D1");
    }
  };
}
