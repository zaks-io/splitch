import { createRepository, envScope } from "../index";
import type { SeededTenants } from "./test-seed";

/**
 * Fixtures shared by the two flag-change suites: one proves the D1 triggers
 * fire, the other proves the repo reads them back under tenant scope. Both need
 * the same writes, and a trigger test that reached for a repo-level fake would
 * assert nothing about the SQL that actually runs.
 *
 * Flag Configuration writes go through the scope-bound repository, like
 * `test-seed.ts`: `flag_configs` is swept for unaccounted writers, and a raw
 * UPDATE here would register as a production writer that skips the version bump.
 */

export const FLAG_CHANGE_NOW = "2026-08-25T00:00:00.000Z";

export type ChangeRow = {
  seq: number;
  appId: string;
  environmentId: string | null;
  flagKey: string;
  action: string;
  targetType: string;
  actorRef: string | null;
  changedAt: string;
  diffJson: string | null;
};

export async function changes(d1: D1Database, appId: string): Promise<ChangeRow[]> {
  const rows = await d1
    .prepare(
      `SELECT seq, app_id AS appId, environment_id AS environmentId, flag_key AS flagKey,
        action, target_type AS targetType, actor_ref AS actorRef, changed_at AS changedAt,
        diff_json AS diffJson
      FROM flag_change_events WHERE app_id = ? ORDER BY seq ASC`,
    )
    .bind(appId)
    .all<ChangeRow>();
  return rows.results;
}

export async function insertConfig(
  d1: D1Database,
  seed: SeededTenants,
  overrides: { id?: string; environmentId?: string } = {},
): Promise<void> {
  const scope = envScope(seed.a.appId, overrides.environmentId ?? seed.a.environmentId);
  await createRepository(d1).flags.ensureInitialFlagConfig(scope, {
    id: overrides.id ?? "cfg_a",
    flagId: seed.a.flagId,
    enabled: false,
    availableVariantNames: "[]",
    createdAt: FLAG_CHANGE_NOW,
    updatedAt: FLAG_CHANGE_NOW,
  });
}

/**
 * A Flag Configuration INSERT is deliberately untriggered (see the migration),
 * so every Environment-scoped config event in these suites comes from a toggle,
 * which is also the only config change a human ever makes.
 */
export async function toggleConfig(
  d1: D1Database,
  seed: SeededTenants,
  environmentId = seed.a.environmentId,
): Promise<void> {
  await createRepository(d1).flags.updateFlagConfig(
    envScope(seed.a.appId, environmentId),
    seed.a.flagId,
    {
      enabled: true,
      updatedAt: FLAG_CHANGE_NOW,
      updatedBy: "user_bob",
      updatedVia: "api-key",
    },
  );
}

export async function insertRule(d1: D1Database, seed: SeededTenants): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO targeting_rules (id, app_id, environment_id, flag_id, priority, conditions,
        created_at, updated_at)
       VALUES ('rule_a', ?, ?, ?, 1, '[]', ?, ?)`,
    )
    .bind(seed.a.appId, seed.a.environmentId, seed.a.flagId, FLAG_CHANGE_NOW, FLAG_CHANGE_NOW)
    .run();
}

/**
 * A second Run on the seeded Experiment. The seed's own Run already fired the
 * insert trigger, so a test that only read the seed could not tell a working
 * trigger from one that never fires.
 */
export async function insertRun(d1: D1Database, seed: SeededTenants): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO runs (id, app_id, environment_id, experiment_id, run_number, status,
        targeting_key_field, targeting_key_type, salt, allocation, variant_set,
        control_variant_id, targeting_rules, confidence_level, decision_family,
        guardrail_decisions, config_hash, started_at, created_at, created_by)
       SELECT 'run_a_two', app_id, environment_id, experiment_id, 2, 'running',
        targeting_key_field, targeting_key_type, 'salt_two', allocation, variant_set,
        control_variant_id, targeting_rules, confidence_level, decision_family,
        guardrail_decisions, 'hash_two', ?, ?, 'user_carol'
       FROM runs WHERE id = ?`,
    )
    .bind(FLAG_CHANGE_NOW, FLAG_CHANGE_NOW, seed.a.runId)
    .run();
}

export async function insertSecondEnvironment(d1: D1Database, seed: SeededTenants): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO environments (id, app_id, key, name, created_at, updated_at)
       VALUES ('env_a_two', ?, 'staging', 'Staging', ?, ?)`,
    )
    .bind(seed.a.appId, FLAG_CHANGE_NOW, FLAG_CHANGE_NOW)
    .run();
}
