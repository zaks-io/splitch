#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = join(repoRoot, "packages", "db");
const configPath = join(dbDir, "wrangler.jsonc");
const now = new Date().toISOString();
const transientSmokeAppKeyPattern = "playwright-smoke-app-%";
const seedTimeoutMs = 60_000;
const cleanupOnly = process.argv.includes("--cleanup-transient");

const ids = {
  app: "app_shared_preview_smoke",
  clientKeyDev: "ck_shared_preview_smoke_dev",
  clientKeyProd: "ck_shared_preview_smoke_prod",
  configDev: "fcfg_shared_preview_smoke_dev",
  configProd: "fcfg_shared_preview_smoke_prod",
  envDev: "env_shared_preview_smoke_dev",
  envProd: "env_shared_preview_smoke_prod",
  flag: "flag_shared_preview_smoke",
  org: "org_shared_preview_smoke",
  user: "user_shared_preview_smoke",
  variantControl: "var_shared_preview_smoke_control",
  variantTreatment: "var_shared_preview_smoke_treatment",
};

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

const cleanupSql = `
DELETE FROM targeting_rules WHERE app_id IN (
  SELECT id FROM apps WHERE organization_id = '${ids.org}' AND key LIKE '${transientSmokeAppKeyPattern}'
);
DELETE FROM flag_configs WHERE app_id IN (
  SELECT id FROM apps WHERE organization_id = '${ids.org}' AND key LIKE '${transientSmokeAppKeyPattern}'
);
DELETE FROM variants WHERE flag_id IN (
  SELECT id FROM flags WHERE app_id IN (
    SELECT id FROM apps WHERE organization_id = '${ids.org}' AND key LIKE '${transientSmokeAppKeyPattern}'
  )
);
DELETE FROM flags WHERE app_id IN (
  SELECT id FROM apps WHERE organization_id = '${ids.org}' AND key LIKE '${transientSmokeAppKeyPattern}'
);
DELETE FROM client_keys WHERE app_id IN (
  SELECT id FROM apps WHERE organization_id = '${ids.org}' AND key LIKE '${transientSmokeAppKeyPattern}'
);
DELETE FROM api_keys WHERE app_id IN (
  SELECT id FROM apps WHERE organization_id = '${ids.org}' AND key LIKE '${transientSmokeAppKeyPattern}'
);
DELETE FROM environments WHERE app_id IN (
  SELECT id FROM apps WHERE organization_id = '${ids.org}' AND key LIKE '${transientSmokeAppKeyPattern}'
);
DELETE FROM app_memberships WHERE app_id IN (
  SELECT id FROM apps WHERE organization_id = '${ids.org}' AND key LIKE '${transientSmokeAppKeyPattern}'
);
DELETE FROM apps WHERE organization_id = '${ids.org}' AND key LIKE '${transientSmokeAppKeyPattern}';
`;

const seedSql = `
INSERT INTO organizations (id, name, plan, created_at, updated_at)
VALUES ('${ids.org}', 'Shared Preview Smoke', 'free', '${now}', '${now}')
ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;

INSERT INTO org_memberships (org_id, user_id, role, created_at)
VALUES ('${ids.org}', '${ids.user}', 'owner', '${now}')
ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role;

INSERT INTO apps (id, organization_id, name, key, description, created_at, updated_at, created_by)
VALUES (
  '${ids.app}',
  '${ids.org}',
  'Shared Preview Smoke',
  'shared-preview-smoke',
  'Stable App for shared-preview smoke tests.',
  '${now}',
  '${now}',
  '${ids.user}'
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

INSERT INTO client_keys (
  key_id, app_id, environment_id, key_material, origin_allowlist, rate_limit_rps, revoked_at, created_at, created_by
)
VALUES ('${ids.clientKeyDev}', '${ids.app}', '${ids.envDev}', 'pk_shared_preview_smoke_dev', NULL, NULL, NULL, '${now}', '${ids.user}')
ON CONFLICT(key_id) DO UPDATE SET revoked_at = NULL;

INSERT INTO client_keys (
  key_id, app_id, environment_id, key_material, origin_allowlist, rate_limit_rps, revoked_at, created_at, created_by
)
VALUES ('${ids.clientKeyProd}', '${ids.app}', '${ids.envProd}', 'pk_shared_preview_smoke_prod', NULL, NULL, NULL, '${now}', '${ids.user}')
ON CONFLICT(key_id) DO UPDATE SET revoked_at = NULL;

INSERT INTO flags (
  id, app_id, key, name, description, schema, default_variant_id, created_at, updated_at, created_by, updated_by
)
VALUES (
  '${ids.flag}',
  '${ids.app}',
  'shared-preview-smoke',
  'Shared Preview Smoke',
  'Stable Flag for shared-preview smoke tests.',
  '{"type":"boolean"}',
  '${ids.variantControl}',
  '${now}',
  '${now}',
  '${ids.user}',
  '${ids.user}'
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
  '${ids.configDev}',
  '${ids.app}',
  '${ids.envDev}',
  '${ids.flag}',
  1,
  '["control","treatment"]',
  '${ids.variantControl}',
  '${now}',
  '${now}'
)
ON CONFLICT(id) DO UPDATE SET enabled = 1, available_variant_names = excluded.available_variant_names, updated_at = excluded.updated_at;

INSERT INTO flag_configs (
  id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, created_at, updated_at
)
VALUES (
  '${ids.configProd}',
  '${ids.app}',
  '${ids.envProd}',
  '${ids.flag}',
  1,
  '["control","treatment"]',
  '${ids.variantControl}',
  '${now}',
  '${now}'
)
ON CONFLICT(id) DO UPDATE SET enabled = 1, available_variant_names = excluded.available_variant_names, updated_at = excluded.updated_at;
`;

const sql = cleanupOnly ? cleanupSql : `${cleanupSql}\n${seedSql}`;

const tempDir = mkdtempSync(join(tmpdir(), "splitch-smoke-seed-"));
const sqlPath = join(tempDir, "seed.sql");

try {
  writeFileSync(sqlPath, sql);
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--remote",
      "--env",
      "shared-preview",
      "--config",
      configPath,
      "--file",
      sqlPath,
    ],
    { cwd: repoRoot, stdio: "inherit", timeout: seedTimeoutMs },
  );

  if (result.error && result.error.code !== "ETIMEDOUT") {
    throw result.error;
  }
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    throw new Error(
      `seed-shared-preview-smoke: wrangler d1 execute timed out after ${seedTimeoutMs}ms`,
    );
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  console.log(
    cleanupOnly
      ? "seed-shared-preview-smoke: removed transient shared-preview smoke Apps"
      : "seed-shared-preview-smoke: seeded shared-preview smoke Organization/App/Flag",
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
