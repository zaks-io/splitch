/** SQL builders for shared-preview smoke seed / transient cleanup. */

import { createHash } from "node:crypto";

export const SMOKE_IDS = {
  app: "app_shared_preview_smoke",
  appOther: "app_shared_preview_smoke_other",
  clientKeyDev: "ck_shared_preview_smoke_dev",
  clientKeyDevRevoked: "ck_shared_preview_smoke_dev_revoked",
  clientKeyOtherDev: "ck_shared_preview_smoke_other_dev",
  clientKeyProd: "ck_shared_preview_smoke_prod",
  configDev: "fcfg_shared_preview_smoke_dev",
  configProd: "fcfg_shared_preview_smoke_prod",
  envDev: "env_shared_preview_smoke_dev",
  envOtherDev: "env_shared_preview_smoke_other_dev",
  envOtherProd: "env_shared_preview_smoke_other_prod",
  envProd: "env_shared_preview_smoke_prod",
  flag: "flag_shared_preview_smoke",
  org: "org_shared_preview_smoke",
  isolationApp: "app_shared_preview_isolation",
  isolationOrg: "org_shared_preview_isolation",
  isolationUser: "user_shared_preview_isolation_owner",
  user: "user_shared_preview_smoke",
  variantControl: "var_shared_preview_smoke_control",
  variantTreatment: "var_shared_preview_smoke_treatment",
};

/**
 * Transient App key prefixes. Every smoke surface that creates an App must use one of
 * these, or its rows survive cleanup and orphan the shared preview.
 */
export const TRANSIENT_APP_KEY_PREFIXES = [
  "playwright-smoke-app-",
  "dark-launch-app-",
  "panel-smoke-app-",
];

/**
 * Every table carrying `app_id`, before its transient App. Foreign-key children
 * must precede their parent, and no-foreign-key recovery rows must be removed
 * before the App-backed selector disappears. Both membership and ordering are
 * checked against the Drizzle schema by shared-preview-panel-smoke.test.mjs.
 */
const TRANSIENT_APP_SCOPED_TABLES = [
  "config_webhook_deliveries",
  "convex_installations",
  "approval_reviews",
  "approval_requests",
  "runs",
  "experiments",
  "metrics",
  "event_definition_versions",
  "event_definitions",
  "targeting_rules",
  "segments",
  "flag_configs",
  "client_keys",
  "api_keys",
  "entity_deletions",
  "privacy_requests",
  "environments",
  "app_memberships",
];

export function buildCleanupSql(ids = SMOKE_IDS) {
  const scope = transientAppScope(ids.org);
  const statements = [
    `DELETE FROM app_deletion_sagas WHERE organization_scope_hash = '${organizationScopeHash(ids.org)}' OR organization_id = '${ids.org}';`,
    ...TRANSIENT_APP_SCOPED_TABLES.map(
      (table) => `DELETE FROM ${table} WHERE app_id IN (${scope});`,
    ),
  ];
  // Variants hang off flags, not apps, so they need the extra hop before flags go.
  statements.push(
    `DELETE FROM variants WHERE flag_id IN (\n  SELECT id FROM flags WHERE app_id IN (${scope})\n);`,
    `DELETE FROM flags WHERE app_id IN (${scope});`,
    `DELETE FROM apps WHERE id IN (${scope});`,
  );
  return `\n${statements.join("\n")}\n`;
}

function organizationScopeHash(organizationId) {
  return createHash("sha256")
    .update(`app-deletion-organization-scope:${organizationId}`)
    .digest("hex");
}

function transientAppScope(orgId) {
  const predicate = TRANSIENT_APP_KEY_PREFIXES.map((prefix) => `key LIKE '${prefix}%'`).join(
    " OR ",
  );
  return `\n  SELECT id FROM apps WHERE organization_id = '${orgId}' AND (${predicate})\n`;
}

/**
 * Grants the real WorkOS user behind the panel smoke login owner access to the seeded
 * Organization and App. The Control Panel session principal is keyed by the WorkOS user
 * id itself, so the seeded synthetic id cannot stand in for it.
 */
export function buildPanelUserSql(now, workosUserId, ids = SMOKE_IDS) {
  if (!/^user_[A-Za-z0-9]+$/.test(workosUserId)) {
    throw new Error(`panel smoke user id is not a WorkOS user id: ${workosUserId}`);
  }
  return `
INSERT INTO org_memberships (org_id, user_id, role, created_at)
VALUES ('${ids.org}', '${workosUserId}', 'owner', '${now}')
ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role;

INSERT INTO app_memberships (app_id, user_id, role, created_at)
VALUES ('${ids.app}', '${workosUserId}', 'owner', '${now}')
ON CONFLICT(app_id, user_id) DO UPDATE SET role = excluded.role;
`;
}

export function buildSeedSql(now, ids = SMOKE_IDS) {
  const allowPolicy = JSON.stringify({
    variantAvailability: "allow",
    targetingRolloutValue: "allow",
    enabledState: "allow",
    startExperimentRun: "allow",
  });
  const confirmPolicy = JSON.stringify({
    variantAvailability: "confirm",
    targetingRolloutValue: "confirm",
    enabledState: "confirm",
    startExperimentRun: "confirm",
  });

  return `
INSERT INTO organizations (id, name, slug, plan, created_at, updated_at)
VALUES (
  '${ids.isolationOrg}', 'Shared Preview Isolation', '${ids.isolationOrg}',
  'free', '${now}', '${now}'
)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug, updated_at = excluded.updated_at;

INSERT INTO org_memberships (org_id, user_id, role, created_at)
VALUES ('${ids.isolationOrg}', '${ids.isolationUser}', 'owner', '${now}')
ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role;

INSERT INTO apps (id, organization_id, name, key, description, created_at, updated_at, created_by)
VALUES (
  '${ids.isolationApp}', '${ids.isolationOrg}', 'Shared Preview Isolation Sentinel',
  'shared-preview-isolation-sentinel', 'Existence witness for cross-Organization denial proofs.',
  '${now}', '${now}', '${ids.isolationUser}'
)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;

INSERT INTO organizations (id, name, slug, plan, created_at, updated_at)
VALUES ('${ids.org}', 'Shared Preview Smoke', '${ids.org}', 'free', '${now}', '${now}')
ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug, updated_at = excluded.updated_at;

INSERT INTO org_memberships (org_id, user_id, role, created_at)
VALUES ('${ids.org}', '${ids.user}', 'owner', '${now}')
ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role;

INSERT INTO apps (id, organization_id, name, key, description, created_at, updated_at, created_by)
VALUES (
  '${ids.app}', '${ids.org}', 'Shared Preview Smoke', 'shared-preview-smoke',
  'Stable App for shared-preview smoke tests.', '${now}', '${now}', '${ids.user}'
)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;

INSERT INTO app_memberships (app_id, user_id, role, created_at)
VALUES ('${ids.app}', '${ids.user}', 'owner', '${now}')
ON CONFLICT(app_id, user_id) DO UPDATE SET role = excluded.role;

INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by)
VALUES ('${ids.envDev}', '${ids.app}', 'dev', 'Dev', '${allowPolicy}', '${now}', '${now}', '${ids.user}')
ON CONFLICT(id) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at;

INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by)
VALUES ('${ids.envProd}', '${ids.app}', 'prod', 'Prod', '${confirmPolicy}', '${now}', '${now}', '${ids.user}')
ON CONFLICT(id) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at;

DELETE FROM client_keys WHERE app_id = '${ids.app}';

INSERT INTO client_keys (
  key_id, app_id, environment_id, key_material, origin_allowlist, rate_limit_rps, revoked_at, created_at, created_by
)
VALUES ('${ids.clientKeyDev}', '${ids.app}', '${ids.envDev}', 'pk_shared_preview_smoke_dev', NULL, NULL, NULL, '${now}', '${ids.user}');

INSERT INTO client_keys (
  key_id, app_id, environment_id, key_material, origin_allowlist, rate_limit_rps, revoked_at, created_at, created_by
)
VALUES (
  '${ids.clientKeyDevRevoked}', '${ids.app}', '${ids.envDev}', 'pk_shared_preview_smoke_dev_revoked',
  NULL, NULL, '${now}', '${now}', '${ids.user}'
);

INSERT INTO client_keys (
  key_id, app_id, environment_id, key_material, origin_allowlist, rate_limit_rps, revoked_at, created_at, created_by
)
VALUES ('${ids.clientKeyProd}', '${ids.app}', '${ids.envProd}', 'pk_shared_preview_smoke_prod', NULL, NULL, NULL, '${now}', '${ids.user}');

INSERT INTO apps (id, organization_id, name, key, description, created_at, updated_at, created_by)
VALUES (
  '${ids.appOther}', '${ids.org}', 'Shared Preview Smoke Other', 'shared-preview-smoke-other',
  'Stable sibling App for wrong-App Client Key proofs.', '${now}', '${now}', '${ids.user}'
)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;

INSERT INTO app_memberships (app_id, user_id, role, created_at)
VALUES ('${ids.appOther}', '${ids.user}', 'owner', '${now}')
ON CONFLICT(app_id, user_id) DO UPDATE SET role = excluded.role;

INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by)
VALUES ('${ids.envOtherDev}', '${ids.appOther}', 'dev', 'Dev', '${allowPolicy}', '${now}', '${now}', '${ids.user}')
ON CONFLICT(id) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at;

INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by)
VALUES ('${ids.envOtherProd}', '${ids.appOther}', 'prod', 'Prod', '${confirmPolicy}', '${now}', '${now}', '${ids.user}')
ON CONFLICT(id) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at;

DELETE FROM client_keys WHERE app_id = '${ids.appOther}';

INSERT INTO client_keys (
  key_id, app_id, environment_id, key_material, origin_allowlist, rate_limit_rps, revoked_at, created_at, created_by
)
VALUES (
  '${ids.clientKeyOtherDev}', '${ids.appOther}', '${ids.envOtherDev}', 'pk_shared_preview_smoke_other_dev',
  NULL, NULL, NULL, '${now}', '${ids.user}'
);

INSERT INTO flags (
  id, app_id, key, name, description, schema, default_variant_id, created_at, updated_at, created_by, updated_by
)
VALUES (
  '${ids.flag}', '${ids.app}', 'shared-preview-smoke', 'Shared Preview Smoke',
  'Stable Flag for shared-preview smoke tests.', '{"type":"boolean"}', '${ids.variantControl}',
  '${now}', '${now}', '${ids.user}', '${ids.user}'
)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;

INSERT INTO variants (id, flag_id, name, value, description, created_at)
VALUES ('${ids.variantControl}', '${ids.flag}', 'control', 'false', 'Smoke control Variant.', '${now}')
ON CONFLICT(id) DO UPDATE SET value = excluded.value;

INSERT INTO variants (id, flag_id, name, value, description, created_at)
VALUES ('${ids.variantTreatment}', '${ids.flag}', 'treatment', 'true', 'Smoke treatment Variant.', '${now}')
ON CONFLICT(id) DO UPDATE SET value = excluded.value;

INSERT INTO flag_configs (
  id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, created_at, updated_at
)
VALUES (
  '${ids.configDev}', '${ids.app}', '${ids.envDev}', '${ids.flag}', 1, '["control","treatment"]',
  '${ids.variantControl}', '${now}', '${now}'
)
ON CONFLICT(id) DO UPDATE SET enabled = 1, available_variant_names = excluded.available_variant_names, updated_at = excluded.updated_at;

INSERT INTO flag_configs (
  id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, created_at, updated_at
)
VALUES (
  '${ids.configProd}', '${ids.app}', '${ids.envProd}', '${ids.flag}', 1, '["control","treatment"]',
  '${ids.variantControl}', '${now}', '${now}'
)
ON CONFLICT(id) DO UPDATE SET enabled = 1, available_variant_names = excluded.available_variant_names, updated_at = excluded.updated_at;
`;
}
