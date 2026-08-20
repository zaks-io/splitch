type AppDeletionSagaPhase = "started" | "d1_deleted" | "complete";

export interface AppDeletionSagaRow {
  readonly appId: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly deleteBeforeTs: string;
  readonly phase: AppDeletionSagaPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AppDeletionSagaInput {
  readonly appId: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly deleteBeforeTs: string;
  readonly now: string;
}

export function makeAppDeletionSagaRepo(d1: D1Database) {
  return {
    async beginAppDeletionSaga(input: AppDeletionSagaInput): Promise<AppDeletionSagaRow> {
      requireInput(input);
      const result = await d1
        .prepare(
          `INSERT INTO app_deletion_sagas (
             app_id, organization_id, actor_id, delete_before_ts, phase, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'started', ?, ?)
           ON CONFLICT (app_id) DO UPDATE SET
             organization_id = excluded.organization_id,
             actor_id = excluded.actor_id,
             delete_before_ts = excluded.delete_before_ts,
             updated_at = excluded.updated_at
           WHERE app_deletion_sagas.phase = 'started'
           RETURNING app_id, organization_id, actor_id, delete_before_ts, phase, created_at, updated_at`,
        )
        .bind(
          input.appId,
          input.organizationId,
          input.actorId,
          input.deleteBeforeTs,
          input.now,
          input.now,
        )
        .first<AppDeletionSagaDbRow>();
      if (!result) throw new Error("App deletion has already crossed the D1 boundary");
      return appDeletionSagaRow(result);
    },

    async getAppDeletionSaga(appId: string): Promise<AppDeletionSagaRow | null> {
      const result = await d1
        .prepare(
          `SELECT app_id, organization_id, actor_id, delete_before_ts, phase, created_at, updated_at
           FROM app_deletion_sagas WHERE app_id = ?`,
        )
        .bind(appId)
        .first<AppDeletionSagaDbRow>();
      return result ? appDeletionSagaRow(result) : null;
    },

    async cancelAppDeletionSaga(appId: string): Promise<void> {
      await d1
        .prepare("DELETE FROM app_deletion_sagas WHERE app_id = ? AND phase = 'started'")
        .bind(appId)
        .run();
    },

    async completeAppDeletionSaga(appId: string, updatedAt: string): Promise<void> {
      const result = await d1
        .prepare(
          `UPDATE app_deletion_sagas SET phase = 'complete', updated_at = ?
           WHERE app_id = ? AND phase IN ('d1_deleted', 'complete') RETURNING app_id`,
        )
        .bind(updatedAt, appId)
        .first<{ app_id: string }>();
      if (!result) throw new Error("App deletion has not crossed the D1 boundary");
    },
  };
}

interface AppDeletionSagaDbRow {
  readonly app_id: string;
  readonly organization_id: string;
  readonly actor_id: string;
  readonly delete_before_ts: string;
  readonly phase: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function appDeletionSagaRow(row: AppDeletionSagaDbRow): AppDeletionSagaRow {
  if (!isPhase(row.phase)) throw new Error(`invalid App deletion phase: ${row.phase}`);
  return {
    appId: row.app_id,
    organizationId: row.organization_id,
    actorId: row.actor_id,
    deleteBeforeTs: row.delete_before_ts,
    phase: row.phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isPhase(value: string): value is AppDeletionSagaPhase {
  return value === "started" || value === "d1_deleted" || value === "complete";
}

function requireInput(input: AppDeletionSagaInput): void {
  if (
    input.appId.length === 0 ||
    input.organizationId.length === 0 ||
    input.actorId.length === 0 ||
    !Number.isFinite(Date.parse(input.deleteBeforeTs)) ||
    !Number.isFinite(Date.parse(input.now))
  ) {
    throw new Error("App deletion saga requires App, Organization, actor, cutoff, and time");
  }
}
