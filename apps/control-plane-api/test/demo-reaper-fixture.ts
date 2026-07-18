export interface RowRef {
  table: TableName;
  column: string;
  value: string;
}

export type TableName =
  | "api_keys"
  | "app_memberships"
  | "apps"
  | "client_keys"
  | "entity_deletions"
  | "environments"
  | "experiments"
  | "flag_configs"
  | "flags"
  | "metrics"
  | "organizations"
  | "org_memberships"
  | "privacy_requests"
  | "runs"
  | "segments"
  | "targeting_rules"
  | "trusted_idps"
  | "variants";

export async function seedAppChildren(
  d1: D1Database,
  orgId: string,
  appId: string,
  environmentId: string,
  nowIso: string,
): Promise<RowRef[]> {
  const flagId = `${appId}_flag`;
  const variantId = `${appId}_variant`;
  const experimentId = `${appId}_experiment`;
  const metricId = `${appId}_metric`;
  const targetingHash = `${appId}_targeting_hash`;
  const refs: RowRef[] = [
    { table: "flags", column: "id", value: flagId },
    { table: "variants", column: "id", value: variantId },
    { table: "flag_configs", column: "flag_id", value: flagId },
    { table: "targeting_rules", column: "flag_id", value: flagId },
    { table: "segments", column: "app_id", value: appId },
    { table: "metrics", column: "id", value: metricId },
    { table: "experiments", column: "id", value: experimentId },
    { table: "runs", column: "experiment_id", value: experimentId },
    { table: "api_keys", column: "app_id", value: appId },
    { table: "client_keys", column: "app_id", value: appId },
    { table: "entity_deletions", column: "targeting_key_hash", value: targetingHash },
    { table: "privacy_requests", column: "app_id", value: appId },
  ];

  await d1
    .prepare(
      "INSERT INTO flags (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(flagId, appId, `${appId}-flag`, "Reaper flag", nowIso, nowIso)
    .run();
  await d1
    .prepare("INSERT INTO variants (id, flag_id, name, value, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(variantId, flagId, "control", JSON.stringify("off"), nowIso)
    .run();
  await d1
    .prepare(
      "INSERT INTO flag_configs (id, app_id, environment_id, flag_id, enabled, available_variant_names, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(`${appId}_flag_config`, appId, environmentId, flagId, 0, '["control"]', nowIso, nowIso)
    .run();
  await d1
    .prepare(
      "INSERT INTO targeting_rules (id, app_id, environment_id, flag_id, priority, conditions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(`${appId}_targeting_rule`, appId, environmentId, flagId, 0, "[]", nowIso, nowIso)
    .run();
  await d1
    .prepare(
      "INSERT INTO segments (id, app_id, name, conditions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(`${appId}_segment`, appId, "Reaper segment", "[]", nowIso, nowIso)
    .run();
  await d1
    .prepare(
      "INSERT INTO metrics (id, app_id, key, name, kind, event_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(metricId, appId, `${appId}-metric`, "Reaper metric", "count", "reaper", nowIso)
    .run();
  await d1
    .prepare(
      "INSERT INTO experiments (id, app_id, environment_id, key, flag_id, name, targeting_key_field, targeting_key_type, metrics, guardrail_metrics, dimensions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      experimentId,
      appId,
      environmentId,
      `${appId}-experiment`,
      flagId,
      "Reaper experiment",
      "userId",
      "user",
      "[]",
      "[]",
      "[]",
      nowIso,
      nowIso,
    )
    .run();
  await d1
    .prepare(
      "INSERT INTO runs (id, app_id, environment_id, experiment_id, run_number, targeting_key_field, targeting_key_type, salt, allocation, variant_set, targeting_rules, confidence_level, decision_family, guardrail_decisions, config_hash, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      `${appId}_run`,
      appId,
      environmentId,
      experimentId,
      1,
      "userId",
      "user",
      `${appId}-salt`,
      '{"control":100}',
      '[{"id":"control","name":"control","value":"off"}]',
      "[]",
      0.95,
      "[]",
      "[]",
      `${appId}-hash`,
      nowIso,
      nowIso,
    )
    .run();
  await d1
    .prepare(
      "INSERT INTO api_keys (key_id, app_id, environment_id, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(`${appId}_api_key`, appId, environmentId, `${appId}-api-hash`, "[]", nowIso)
    .run();
  await d1
    .prepare(
      "INSERT INTO client_keys (key_id, app_id, environment_id, key_material, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(`${appId}_client_key`, appId, environmentId, `${appId}-client-key`, nowIso)
    .run();
  await d1
    .prepare(
      "INSERT INTO entity_deletions (app_id, id_type, targeting_key_hash, delete_before_ts, requested_at) VALUES (?, 'user', ?, ?, ?)",
    )
    .bind(appId, targetingHash, nowIso, nowIso)
    .run();
  await d1
    .prepare(
      "INSERT INTO privacy_requests (request_id, org_id, app_id, request_type, subject_type, subject_ref, requested_by, status, received_at, ack_due_at, response_due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      `${appId}_privacy_request`,
      orgId,
      appId,
      "delete",
      "user",
      `${appId}-subject`,
      `${orgId}_owner`,
      "received",
      nowIso,
      nowIso,
      nowIso,
    )
    .run();

  return refs;
}
