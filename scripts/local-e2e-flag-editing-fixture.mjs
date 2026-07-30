import { runConfigHash } from "./local-e2e-run-hash.mjs";

/**
 * The App the Flag-editing matrix writes to (SPL-118).
 *
 * It is deliberately its own App rather than a corner of `checkout-api`: every
 * test in that matrix MUTATES a Flag Configuration, and a spec that writes to a
 * fixture another spec reads turns an unrelated failure into a fixture bug. One
 * Flag per change type, for the same reason — two tests sharing a Flag make the
 * second one depend on the first one's outcome.
 *
 * Two Environments, and the only difference between them is the Policy:
 *   dev  — `allow` on everything, so a change applies immediately
 *   prod — `confirm` on everything, so the same change becomes an Approval Request
 * Anything the matrix proves about gating therefore comes from the Policy alone.
 */
export const LOCAL_E2E_FLAG_EDITING = Object.freeze({
  appId: "app_editing_e2e",
  appSlug: "flag-editing",
  allowEnvironmentKey: "dev",
  confirmEnvironmentKey: "prod",
  flags: Object.freeze({
    enabledState: "edit-enabled",
    availability: "edit-availability",
    rollout: "edit-rollout",
    targeting: "edit-targeting",
    danglingVariant: "edit-dangling",
    experimentLocked: "edit-locked",
  }),
});

const createdAt = "2026-07-18T00:00:00.000Z";
const lockedVariants = [
  { id: "variant_editing_locked_control_e2e", name: "control", value: false },
  { id: "variant_editing_locked_treatment_e2e", name: "treatment", value: true },
];
const lockedRunSalt = "local-e2e-editing-locked";
const lockedRunHash = runConfigHash({
  salt: lockedRunSalt,
  allocation: { control: 50, treatment: 50 },
  variantSet: lockedVariants,
  targetingRules: [],
});

export const LOCAL_E2E_FLAG_EDITING_SEED = `
INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
  ('app_editing_e2e', 'org_acme_e2e', 'Flag Editing', 'flag-editing', '${createdAt}', '${createdAt}', 'user_local_e2e');
INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES
  ('app_editing_e2e', 'user_local_e2e', 'admin', '${createdAt}');
INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by) VALUES
  ('env_editing_dev_e2e', 'app_editing_e2e', 'dev', 'Development', '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_editing_prod_e2e', 'app_editing_e2e', 'prod', 'Production', '{"variantAvailability":"confirm","targetingRolloutValue":"confirm","enabledState":"confirm","startExperimentRun":"confirm"}', '${createdAt}', '${createdAt}', 'user_local_e2e');
INSERT INTO flags (id, app_id, key, name, schema, default_variant_id, created_at, updated_at, created_by, updated_by) VALUES
  ('flag_editing_enabled_e2e', 'app_editing_e2e', 'edit-enabled', 'Edit Enabled', '{"type":"boolean"}', 'variant_editing_enabled_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_editing_availability_e2e', 'app_editing_e2e', 'edit-availability', 'Edit Availability', '{"type":"boolean"}', 'variant_editing_availability_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_editing_rollout_e2e', 'app_editing_e2e', 'edit-rollout', 'Edit Rollout', '{"type":"boolean"}', 'variant_editing_rollout_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_editing_targeting_e2e', 'app_editing_e2e', 'edit-targeting', 'Edit Targeting', '{"type":"boolean"}', 'variant_editing_targeting_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_editing_dangling_e2e', 'app_editing_e2e', 'edit-dangling', 'Edit Dangling', '{"type":"boolean"}', 'variant_editing_dangling_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_editing_locked_e2e', 'app_editing_e2e', 'edit-locked', 'Edit Locked', '{"type":"boolean"}', '${lockedVariants[0].id}', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e');
INSERT INTO variants (id, flag_id, name, value, created_at) VALUES
  ('variant_editing_enabled_control_e2e', 'flag_editing_enabled_e2e', 'control', 'false', '${createdAt}'),
  ('variant_editing_enabled_treatment_e2e', 'flag_editing_enabled_e2e', 'treatment', 'true', '${createdAt}'),
  ('variant_editing_availability_control_e2e', 'flag_editing_availability_e2e', 'control', 'false', '${createdAt}'),
  ('variant_editing_availability_treatment_e2e', 'flag_editing_availability_e2e', 'treatment', 'true', '${createdAt}'),
  ('variant_editing_rollout_control_e2e', 'flag_editing_rollout_e2e', 'control', 'false', '${createdAt}'),
  ('variant_editing_rollout_treatment_e2e', 'flag_editing_rollout_e2e', 'treatment', 'true', '${createdAt}'),
  ('variant_editing_targeting_control_e2e', 'flag_editing_targeting_e2e', 'control', 'false', '${createdAt}'),
  ('variant_editing_targeting_treatment_e2e', 'flag_editing_targeting_e2e', 'treatment', 'true', '${createdAt}'),
  ('variant_editing_dangling_control_e2e', 'flag_editing_dangling_e2e', 'control', 'false', '${createdAt}'),
  ('variant_editing_dangling_treatment_e2e', 'flag_editing_dangling_e2e', 'treatment', 'true', '${createdAt}'),
  ('${lockedVariants[0].id}', 'flag_editing_locked_e2e', 'control', 'false', '${createdAt}'),
  ('${lockedVariants[1].id}', 'flag_editing_locked_e2e', 'treatment', 'true', '${createdAt}');
INSERT INTO flag_configs (id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, created_at, updated_at) VALUES
  ('config_editing_enabled_dev_e2e', 'app_editing_e2e', 'env_editing_dev_e2e', 'flag_editing_enabled_e2e', 0, '["control","treatment"]', 'variant_editing_enabled_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_editing_enabled_prod_e2e', 'app_editing_e2e', 'env_editing_prod_e2e', 'flag_editing_enabled_e2e', 0, '["control","treatment"]', 'variant_editing_enabled_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_editing_availability_dev_e2e', 'app_editing_e2e', 'env_editing_dev_e2e', 'flag_editing_availability_e2e', 1, '["control"]', 'variant_editing_availability_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_editing_availability_prod_e2e', 'app_editing_e2e', 'env_editing_prod_e2e', 'flag_editing_availability_e2e', 1, '["control"]', 'variant_editing_availability_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_editing_rollout_dev_e2e', 'app_editing_e2e', 'env_editing_dev_e2e', 'flag_editing_rollout_e2e', 1, '["control","treatment"]', 'variant_editing_rollout_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_editing_rollout_prod_e2e', 'app_editing_e2e', 'env_editing_prod_e2e', 'flag_editing_rollout_e2e', 1, '["control","treatment"]', 'variant_editing_rollout_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_editing_targeting_dev_e2e', 'app_editing_e2e', 'env_editing_dev_e2e', 'flag_editing_targeting_e2e', 1, '["control","treatment"]', 'variant_editing_targeting_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_editing_targeting_prod_e2e', 'app_editing_e2e', 'env_editing_prod_e2e', 'flag_editing_targeting_e2e', 1, '["control","treatment"]', 'variant_editing_targeting_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_editing_dangling_dev_e2e', 'app_editing_e2e', 'env_editing_dev_e2e', 'flag_editing_dangling_e2e', 1, '["control"]', 'variant_editing_dangling_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_editing_locked_prod_e2e', 'app_editing_e2e', 'env_editing_prod_e2e', 'flag_editing_locked_e2e', 1, '["control","treatment"]', '${lockedVariants[0].id}', '${createdAt}', '${createdAt}');
INSERT INTO experiments (id, app_id, environment_id, key, flag_id, name, status, targeting_key_field, targeting_key_type, default_variant_id, metrics, guardrail_metrics, dimensions, live_run_id, created_at, updated_at, created_by, updated_by) VALUES
  ('experiment_editing_locked_e2e', 'app_editing_e2e', 'env_editing_prod_e2e', 'edit-locked', 'flag_editing_locked_e2e', 'Edit Locked Run', 'running', 'targetingKey', 'user', '${lockedVariants[0].id}', '[]', '[]', '[]', 'run_editing_locked_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e');
INSERT INTO runs (id, app_id, environment_id, experiment_id, run_number, status, targeting_key_field, targeting_key_type, salt, allocation, variant_set, control_variant_id, targeting_rules, confidence_level, decision_family, guardrail_decisions, config_hash, started_at, created_at, created_by) VALUES
  ('run_editing_locked_e2e', 'app_editing_e2e', 'env_editing_prod_e2e', 'experiment_editing_locked_e2e', 1, 'running', 'targetingKey', 'user', '${lockedRunSalt}', '{"control":50,"treatment":50}', '${JSON.stringify(lockedVariants)}', '${lockedVariants[0].id}', '[]', 0.95, '[]', '[]', '${lockedRunHash}', '${createdAt}', '${createdAt}', 'user_local_e2e');
`;
