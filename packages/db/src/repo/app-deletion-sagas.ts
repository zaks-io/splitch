type AppDeletionSagaPhase = "started" | "d1_deleted" | "complete";

export interface AppDeletionSagaRow {
  readonly appId: string;
  readonly generationId: string;
  readonly organizationId: string | null;
  readonly actorId: string | null;
  readonly deleteBeforeTs: string | null;
  readonly retryActorHash: string | null;
  readonly organizationScopeHash: string | null;
  readonly phase: AppDeletionSagaPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AppDeletionSagaInput {
  readonly appId: string;
  readonly generationId: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly deleteBeforeTs: string;
  readonly now: string;
}

export function makeAppDeletionSagaRepo(d1: D1Database) {
  return {
    async beginAppDeletionSaga(input: AppDeletionSagaInput): Promise<AppDeletionSagaRow> {
      requireInput(input);
      const retryActorHash = await appDeletionRetryActorHash(input.appId, input.actorId);
      const organizationScopeHash = await hashDeletionIdentity(
        "organization-scope",
        input.organizationId,
      );
      const result = await d1
        .prepare(
          `INSERT INTO app_deletion_sagas (
             app_id, generation_id, organization_id, actor_id, delete_before_ts, retry_actor_hash,
             organization_scope_hash,
             phase, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)
           ON CONFLICT (app_id) DO NOTHING
           RETURNING app_id, generation_id, organization_id, actor_id, delete_before_ts, retry_actor_hash,
             organization_scope_hash, phase, created_at, updated_at`,
        )
        .bind(
          input.appId,
          input.generationId,
          input.organizationId,
          input.actorId,
          input.deleteBeforeTs,
          retryActorHash,
          organizationScopeHash,
          input.now,
          input.now,
        )
        .first<AppDeletionSagaDbRow>();
      if (result) return appDeletionSagaRow(result);
      const existing = await this.getAppDeletionSaga(input.appId);
      if (
        existing?.phase === "started" &&
        existing.organizationId === input.organizationId &&
        existing.actorId === input.actorId
      ) {
        return existing;
      }
      throw new Error("App deletion already has a different active recovery record");
    },

    async getAppDeletionSaga(appId: string): Promise<AppDeletionSagaRow | null> {
      const result = await d1
        .prepare(
          `SELECT app_id, generation_id, organization_id, actor_id, delete_before_ts, retry_actor_hash,
             organization_scope_hash, phase, created_at, updated_at
           FROM app_deletion_sagas WHERE app_id = ?`,
        )
        .bind(appId)
        .first<AppDeletionSagaDbRow>();
      return result ? appDeletionSagaRow(result) : null;
    },

    async cancelAppDeletionSaga(input: {
      appId: string;
      organizationId: string;
      actorId: string;
      deleteBeforeTs: string;
      generationId: string;
    }): Promise<boolean> {
      const result = await d1
        .prepare(
          `DELETE FROM app_deletion_sagas
           WHERE app_id = ? AND organization_id = ? AND actor_id = ?
             AND delete_before_ts = ? AND generation_id = ? AND phase = 'started'`,
        )
        .bind(
          input.appId,
          input.organizationId,
          input.actorId,
          input.deleteBeforeTs,
          input.generationId,
        )
        .run();
      return result.meta.changes === 1;
    },

    async completeAppDeletionSaga(input: {
      appId: string;
      generationId: string;
      updatedAt: string;
    }): Promise<void> {
      const existing = await this.getAppDeletionSaga(input.appId);
      requireCompletableSaga(existing);
      if (existing.generationId !== input.generationId) {
        throw new Error("App deletion generation does not match the active recovery record");
      }
      const { retryActorHash, organizationScopeHash } = await completionHashes(existing);
      const result = await d1
        .prepare(
          `UPDATE app_deletion_sagas
           SET phase = 'complete', organization_id = NULL, actor_id = NULL,
             delete_before_ts = NULL, retry_actor_hash = ?, organization_scope_hash = ?,
             updated_at = ?
           WHERE app_id = ? AND generation_id = ?
             AND phase IN ('d1_deleted', 'complete') RETURNING app_id`,
        )
        .bind(
          retryActorHash,
          organizationScopeHash,
          input.updatedAt,
          input.appId,
          input.generationId,
        )
        .first<{ app_id: string }>();
      if (!result) throw new Error("App deletion has not crossed the D1 boundary");
    },
  };
}

function requireCompletableSaga(
  saga: AppDeletionSagaRow | null,
): asserts saga is AppDeletionSagaRow {
  if (!saga || (saga.phase !== "d1_deleted" && saga.phase !== "complete")) {
    throw new Error("App deletion has not crossed the D1 boundary");
  }
}

async function completionHashes(saga: AppDeletionSagaRow): Promise<{
  retryActorHash: string;
  organizationScopeHash: string;
}> {
  const retryActorHash =
    saga.retryActorHash ??
    (saga.actorId === null ? null : await appDeletionRetryActorHash(saga.appId, saga.actorId));
  const organizationScopeHash =
    saga.organizationScopeHash ??
    (saga.organizationId === null
      ? null
      : await hashDeletionIdentity("organization-scope", saga.organizationId));
  if (retryActorHash === null || organizationScopeHash === null) {
    throw new Error("App deletion completion authorization is incomplete");
  }
  return { retryActorHash, organizationScopeHash };
}

interface AppDeletionSagaDbRow {
  readonly app_id: string;
  readonly generation_id: string;
  readonly organization_id: string | null;
  readonly actor_id: string | null;
  readonly delete_before_ts: string | null;
  readonly retry_actor_hash: string | null;
  readonly organization_scope_hash: string | null;
  readonly phase: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function appDeletionSagaRow(row: AppDeletionSagaDbRow): AppDeletionSagaRow {
  if (!isPhase(row.phase)) throw new Error(`invalid App deletion phase: ${row.phase}`);
  return {
    appId: row.app_id,
    generationId: row.generation_id,
    organizationId: row.organization_id,
    actorId: row.actor_id,
    deleteBeforeTs: row.delete_before_ts,
    retryActorHash: row.retry_actor_hash,
    organizationScopeHash: row.organization_scope_hash,
    phase: row.phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function appDeletionRetryActorHash(appId: string, actorId: string): Promise<string> {
  return hashDeletionIdentity("retry-actor", `${appId}:${actorId}`);
}

async function hashDeletionIdentity(domain: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`app-deletion-${domain}:${value}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isPhase(value: string): value is AppDeletionSagaPhase {
  return value === "started" || value === "d1_deleted" || value === "complete";
}

function requireInput(input: AppDeletionSagaInput): void {
  if (
    input.appId.length === 0 ||
    input.generationId.length === 0 ||
    input.organizationId.length === 0 ||
    input.actorId.length === 0 ||
    !Number.isFinite(Date.parse(input.deleteBeforeTs)) ||
    !Number.isFinite(Date.parse(input.now))
  ) {
    throw new Error("App deletion saga requires App, Organization, actor, cutoff, and time");
  }
}
