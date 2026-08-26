import { assertMintedScope, type TenantScope } from "./scope";

export interface AppDeletionBoundary {
  readonly generationId: string;
  readonly actorId: string;
  readonly organizationId: string;
  readonly deleteBeforeTs: string;
  readonly updatedAt: string;
}

/**
 * Atomic App teardown (SPL-298).
 *
 * App delete previously removed Environments, credentials, and App memberships
 * as separate D1 statements, then deleted the App row last. When a leftover
 * child (notably `approval_requests`) made the final DELETE fail under FK
 * enforcement, memberships were already gone: org-scoped reads still listed the
 * App, but every app-scoped grant and route failed live-membership checks.
 *
 * `d1.batch` is the transaction boundary. Privacy ledger rows (entity deletions
 * + App-scoped privacy requests), Approval history, revoked credentials,
 * Environments, memberships, and the App row commit together or not at all —
 * so a late FK failure cannot wipe GDPR tombstones on a live App (SPL-326).
 * Callers must still refuse non-cascaded children (flags, segments, metrics,
 * non-archived Experiments, …) before invoking this; the batch is the last
 * line of defense against a partial cascade, not a substitute for the
 * emptiness guard. Privacy rows are the exception: force-delete finishes by
 * cascading them here atomically with the App.
 *
 * Approval Requests / Reviews are App-scoped change history with no dedicated
 * delete API. Cascading them here is what makes App delete reachable after a
 * Policy-gated Flag lifecycle — without that, every approved change permanently
 * blocked teardown.
 *
 * Credential DELETE is `revoked_at IS NOT NULL` only. Callers must revoke +
 * tombstone first; a key minted after that scan stays live, keeps its Env/App
 * FK, and forces the whole batch to roll back instead of leaving an active KV
 * entry for a deleted App.
 *
 * Archived Experiment + Run rows are purged here (same SQL as Environment
 * teardown) so Environment FKs can clear once only archived rows remain.
 */

export function makeDeleteAppCascade(d1: D1Database) {
  return async function deleteAppCascade(
    scope: TenantScope,
    boundary?: AppDeletionBoundary,
  ): Promise<void> {
    assertMintedScope(scope);
    const appId = scope.appId;
    const boundaryStatements = boundary
      ? [
          d1
            .prepare(
              `UPDATE app_deletion_sagas SET phase = 'd1_deleted', updated_at = ?
               WHERE app_id = ? AND organization_id = ? AND actor_id = ?
                 AND delete_before_ts = ? AND generation_id = ? AND phase = 'started'
               RETURNING app_id`,
            )
            .bind(
              boundary.updatedAt,
              appId,
              boundary.organizationId,
              boundary.actorId,
              boundary.deleteBeforeTs,
              boundary.generationId,
            ),
          // A zero-row UPDATE must abort the batch before any child deletion.
          // SQLite evaluates the invalid JSON branch only when `changes()` is 0.
          d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('') END"),
        ]
      : [];
    const statements = [
      ...boundaryStatements,
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
      // Privacy FKs → apps (ON DELETE no action). Must clear before App DELETE,
      // inside this batch so a rollback restores tombstones with the App.
      d1.prepare(`DELETE FROM entity_deletions WHERE app_id = ?`).bind(appId),
      d1
        .prepare(
          `DELETE FROM privacy_requests
           WHERE app_id = ?
             AND org_id = (SELECT organization_id FROM apps WHERE id = ?)`,
        )
        .bind(appId, appId),
      // Reviews FK → requests; requests FK → apps. Order matters inside the batch.
      d1.prepare(`DELETE FROM approval_reviews WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM approval_requests WHERE app_id = ?`).bind(appId),
      // Immutable Event Definition publication history has no standalone
      // delete route, so it is cascaded with its owning App.
      d1.prepare(`DELETE FROM event_definition_versions WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM event_definitions WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM api_keys WHERE app_id = ? AND revoked_at IS NOT NULL`).bind(appId),
      d1.prepare(`DELETE FROM client_keys WHERE app_id = ? AND revoked_at IS NOT NULL`).bind(appId),
      // Integration installations FK to apps AND environments, so they must clear
      // before either. Each delivery table FKs its own installations table, so
      // deliveries go first.
      d1.prepare(`DELETE FROM config_webhook_deliveries WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM convex_installations WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM cloudflare_config_deliveries WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM cloudflare_installations WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM sentry_installations WHERE app_id = ?`).bind(appId),
      // The flag-change log carries no FKs (an audit row outlives its subject),
      // so nothing forces this delete. The App's history is still the App's data
      // and a hard delete must take it. Placed after every statement above whose
      // deletion could fire an audit trigger and write fresh rows.
      d1.prepare(`DELETE FROM flag_change_events WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM environments WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM app_memberships WHERE app_id = ?`).bind(appId),
      d1.prepare(`DELETE FROM apps WHERE id = ? RETURNING id`).bind(appId),
    ];
    const results = await d1.batch(statements);
    if ((results[results.length - 1]?.results ?? []).length !== 1) {
      throw new Error("app delete did not reach D1");
    }
    if (boundary && (results[0]?.results ?? []).length !== 1) {
      throw new Error("App deletion boundary did not reach D1");
    }
  };
}
