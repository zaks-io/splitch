const createdAt = "2026-07-18T00:00:00.000Z";

/**
 * The Apps App Settings (SPL-114) is proven against. The spec renames its App
 * and then deletes it, so it can share one with nothing else, and a retry cannot
 * reuse the App its first attempt destroyed: one App per attempt, indexed by
 * `testInfo.retry` the same way the Environment Settings spec is.
 *
 * Each one holds a Flag so the delete dry run has something to name. An App with
 * nothing in it would let a danger zone that lists no consequences pass.
 */
export const LOCAL_E2E_SETTINGS_APP_SLUGS = Object.freeze(["settings-lab", "settings-lab-retry"]);

export const LOCAL_E2E_SETTINGS_APPS = LOCAL_E2E_SETTINGS_APP_SLUGS.map((slug, index) => {
  const stem = slug.replaceAll("-", "_");
  return {
    slug,
    name: index === 0 ? "Settings Lab" : "Settings Lab Retry",
    appId: `app_${stem}_e2e`,
    environmentId: `env_${stem}_prod_e2e`,
    flagId: `flag_${stem}_e2e`,
    variantId: `variant_${stem}_e2e`,
  };
});

export const LOCAL_E2E_APP_SETTINGS_SEED = `-- Apps reserved for App Settings (SPL-114), one per attempt. Owned outright by
-- the owner principal, because renaming and deleting an App are owner-gated, and
-- carrying a Flag so the delete dry run has a consequence to name.
INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
${LOCAL_E2E_SETTINGS_APPS.map(
  (app) =>
    `  ('${app.appId}', 'org_acme_e2e', '${app.name}', '${app.slug}', '${createdAt}', '${createdAt}', 'user_local_e2e')`,
).join(",\n")};
INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by) VALUES
${LOCAL_E2E_SETTINGS_APPS.map(
  (app) =>
    `  ('${app.environmentId}', '${app.appId}', 'prod', 'Production', '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}', '${createdAt}', '${createdAt}', 'user_local_e2e')`,
).join(",\n")};
INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES
${LOCAL_E2E_SETTINGS_APPS.map(
  (app) => `  ('${app.appId}', 'user_local_e2e', 'owner', '${createdAt}')`,
).join(",\n")};
INSERT INTO flags (id, app_id, key, name, schema, default_variant_id, created_at, updated_at, created_by, updated_by) VALUES
${LOCAL_E2E_SETTINGS_APPS.map(
  (app) =>
    `  ('${app.flagId}', '${app.appId}', 'settings-catalog', 'Settings Catalog', '{"type":"boolean"}', '${app.variantId}', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e')`,
).join(",\n")};
INSERT INTO variants (id, flag_id, name, value, created_at) VALUES
${LOCAL_E2E_SETTINGS_APPS.map(
  (app) =>
    `  ('${app.variantId}', '${app.flagId}', 'control', 'false', '${createdAt}'),\n  ('${app.variantId}_treatment', '${app.flagId}', 'treatment', 'true', '${createdAt}')`,
).join(",\n")};`;
