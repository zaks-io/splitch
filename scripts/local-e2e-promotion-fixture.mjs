/**
 * The App the Promotion matrix writes to (SPL-122).
 *
 * Its own App, and one Flag per scenario, for the same reason the Flag-editing
 * matrix is built that way: every one of these tests MUTATES a Flag Configuration
 * in `prod`, so a shared Flag would make each test depend on the previous one's
 * outcome.
 *
 * Two Environments, and the only difference between them is the Policy:
 *   staging — `allow` on everything, and the SOURCE, which is never written
 *   prod    — `confirm` on everything, so a Promotion becomes an Approval Request
 * Anything the matrix proves about gating therefore comes from the target
 * Environment's Policy alone, which is the rule promotion is governed by.
 *
 * `promote-framing` is the one Flag no test ever submits: it backs the assertions
 * about how the screen frames an UNTOUCHED diff, which stop being true the moment
 * some other test promotes the difference away.
 *
 * `promote-dangling` is the refusal case: staging serves `beta` from a Targeting
 * Rule and prod does not have `beta` available, so promoting the rules WITHOUT the
 * availability row is the dangling reference the Worker rejects.
 */
export const LOCAL_E2E_PROMOTION = Object.freeze({
  appId: "app_promotion_e2e",
  appSlug: "promotion",
  sourceEnvironmentKey: "staging",
  targetEnvironmentKey: "prod",
  flags: Object.freeze({
    wholeConfig: "promote-whole",
    singleVariant: "promote-variant",
    availabilityOnly: "promote-availability",
    danglingVariant: "promote-dangling",
    framing: "promote-framing",
  }),
});

const createdAt = "2026-07-31T00:00:00.000Z";
const allow =
  '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}';
const confirm =
  '{"variantAvailability":"confirm","targetingRolloutValue":"confirm","enabledState":"confirm","startExperimentRun":"confirm"}';

/** Every fixture Flag has the same three-Variant catalog, so the diffs are comparable. */
const FLAGS = [
  { slug: "whole", key: "promote-whole", name: "Promote Whole Config" },
  { slug: "variant", key: "promote-variant", name: "Promote Single Variant" },
  { slug: "availability", key: "promote-availability", name: "Promote Availability Only" },
  { slug: "dangling", key: "promote-dangling", name: "Promote Dangling Variant" },
  { slug: "framing", key: "promote-framing", name: "Promote Framing" },
];

const flagId = (slug) => `flag_promotion_${slug}_e2e`;
const variantId = (slug, name) => `variant_promotion_${slug}_${name}_e2e`;

const conditions = JSON.stringify([{ attribute: "plan", operator: "eq", value: "pro" }]);
const rollout = (slug) => JSON.stringify({ percentage: 10, salt: `local-e2e-promotion-${slug}` });

const rows = (build) => FLAGS.map(build).join(",\n");

export const LOCAL_E2E_PROMOTION_SEED = `
INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
  ('app_promotion_e2e', 'org_acme_e2e', 'Promotion', 'promotion', '${createdAt}', '${createdAt}', 'user_local_e2e');
INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES
  ('app_promotion_e2e', 'user_local_e2e', 'admin', '${createdAt}');
INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by) VALUES
  ('env_promotion_staging_e2e', 'app_promotion_e2e', 'staging', 'Staging', '${allow}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_promotion_prod_e2e', 'app_promotion_e2e', 'prod', 'Production', '${confirm}', '${createdAt}', '${createdAt}', 'user_local_e2e');
INSERT INTO flags (id, app_id, key, name, schema, default_variant_id, created_at, updated_at, created_by, updated_by) VALUES
${rows(
  (flag) =>
    `  ('${flagId(flag.slug)}', 'app_promotion_e2e', '${flag.key}', '${flag.name}', '{"type":"boolean"}', '${variantId(flag.slug, "control")}', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e')`,
)};
INSERT INTO variants (id, flag_id, name, value, created_at) VALUES
${rows(
  (flag) =>
    `  ('${variantId(flag.slug, "control")}', '${flagId(flag.slug)}', 'control', 'false', '${createdAt}'),
  ('${variantId(flag.slug, "beta")}', '${flagId(flag.slug)}', 'beta', 'true', '${createdAt}'),
  ('${variantId(flag.slug, "holdout")}', '${flagId(flag.slug)}', 'holdout', 'false', '${createdAt}')`,
)};
INSERT INTO flag_configs (id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, rollout, created_at, updated_at) VALUES
${rows(
  (flag) =>
    `  ('config_promotion_${flag.slug}_staging_e2e', 'app_promotion_e2e', 'env_promotion_staging_e2e', '${flagId(flag.slug)}', 1, '["control","beta"]', '${variantId(flag.slug, "control")}', '${rollout(flag.slug)}', '${createdAt}', '${createdAt}'),
  ('config_promotion_${flag.slug}_prod_e2e', 'app_promotion_e2e', 'env_promotion_prod_e2e', '${flagId(flag.slug)}', 0, '["control"]', '${variantId(flag.slug, "control")}', NULL, '${createdAt}', '${createdAt}')`,
)};
INSERT INTO targeting_rules (id, app_id, environment_id, flag_id, priority, conditions, variant_id, percentage_rollout, created_at, updated_at) VALUES
${rows(
  (flag) =>
    `  ('rule_promotion_${flag.slug}_e2e', 'app_promotion_e2e', 'env_promotion_staging_e2e', '${flagId(flag.slug)}', 0, '${conditions}', '${variantId(flag.slug, "beta")}', '{"percentage":25,"salt":"local-e2e-promotion-rule-${flag.slug}"}', '${createdAt}', '${createdAt}')`,
)};
`;
