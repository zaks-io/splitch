import { createHash } from "node:crypto";
import { LOCAL_E2E_FLAG_EDITING_SEED } from "./local-e2e-flag-editing-fixture.mjs";
import { LOCAL_E2E_PROMOTION_SEED } from "./local-e2e-promotion-fixture.mjs";
import { d1RunDecisions, LOCAL_E2E_RUN_CONFIG as run } from "./local-e2e-run-config.mjs";

export const LOCAL_E2E_SESSION_TOKEN = `spl_${"101e2e".padEnd(64, "0")}`;
export const LOCAL_E2E_SESSION_KEY = `session:${createHash("sha256")
  .update(LOCAL_E2E_SESSION_TOKEN)
  .digest("hex")}`;
export const LOCAL_E2E_MEMBER_SESSION_TOKEN = `spl_${"141e2e".padEnd(64, "0")}`;
export const LOCAL_E2E_MEMBER_SESSION_KEY = `session:${createHash("sha256")
  .update(LOCAL_E2E_MEMBER_SESSION_TOKEN)
  .digest("hex")}`;
/**
 * A signed-in User who belongs to no Organization at all (SPL-205). Every other
 * fixture principal already has memberships, so the landing page a brand new
 * User actually sees was unreachable from e2e until this existed. Deliberately
 * absent from `LOCAL_E2E_D1_SEED`: zero memberships means zero rows.
 */
export const LOCAL_E2E_NEWCOMER_SESSION_TOKEN = `spl_${"205e2e".padEnd(64, "0")}`;
export const LOCAL_E2E_NEWCOMER_SESSION_KEY = `session:${createHash("sha256")
  .update(LOCAL_E2E_NEWCOMER_SESSION_TOKEN)
  .digest("hex")}`;

/**
 * A signed-in User with a profile but no Organization membership anywhere: the
 * person the Members screen adds and then removes. Kept out of `org_memberships`
 * on purpose, so the add leg starts from a real absence every run.
 */
export const LOCAL_E2E_RECRUIT_USER_ID = "user_local_recruit_e2e";

/**
 * `member-profile:{userId}` in SESSION_STORE, mirroring
 * `memberProfileCacheKey` in @splitch/contracts. Org member responses resolve
 * email from here (never a D1 column), so a membership row without a profile
 * makes the whole member list refuse with USER_NOT_FOUND.
 */
export const LOCAL_E2E_MEMBER_PROFILES = Object.freeze({
  user_local_e2e: "owner@acme-labs.e2e",
  user_local_member_e2e: "member@acme-labs.e2e",
  [LOCAL_E2E_RECRUIT_USER_ID]: "recruit@acme-labs.e2e",
});

export function memberProfileKey(userId) {
  return `member-profile:${userId}`;
}

export const LOCAL_E2E_FIXTURE_CONTRACT = Object.freeze({
  organization: {
    id: "org_acme_e2e",
    slug: "acme-labs",
  },
  app: {
    id: "app_checkout_e2e",
    slug: "checkout-api",
    environments: [
      {
        id: "env_checkout_dev_e2e",
        key: "dev",
        attention: { state: "clear", srm: false, guardrail: false },
      },
      {
        id: "env_checkout_prod_e2e",
        key: "prod",
        attention: { state: "attention", srm: true, guardrail: false },
      },
    ],
  },
  principals: {
    owner: { userId: "user_local_e2e", orgRole: "owner", appRole: "owner" },
    member: { userId: "user_local_member_e2e", orgRole: "member", appRole: "member" },
  },
});

/**
 * The Environments the App Overview is proven against, one per attention state.
 * Each state gets its own Environment and its own Flag Configuration rows, so a
 * card that reads another state's rows shows up as the wrong card rather than as
 * a coincidentally matching one.
 */
export const LOCAL_E2E_OVERVIEW_STATES = Object.freeze({
  experimentsUnavailable: { environmentKey: "dev", environmentId: "env_checkout_dev_e2e" },
  flagChanges: {
    environmentKey: "overview-changes",
    environmentId: "env_checkout_overview_e2e",
    recentFlagKey: "new-checkout",
    staleFlagKey: "checkout-srm",
  },
  calm: { environmentKey: "calm", environmentId: "env_checkout_calm_e2e" },
});

const createdAt = "2026-07-18T00:00:00.000Z";
// The Overview's recently-changed window is relative to now, so the Flag
// Configuration that must land inside it needs a relative timestamp; a frozen
// one silently ages out of the window and the fixture stops proving anything.
const recentlyChangedAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
const staleChangedAt = "2026-06-01T00:00:00.000Z";
const json = JSON.stringify;

/**
 * One empty App per onboarding test. Flags are App-scoped, so a test that creates
 * a Flag destroys the teaching empty state for anything that runs after it — and
 * a retry re-runs a test against an App its own first attempt already wrote to.
 * Giving each test its own App makes the onboarding spec order- and
 * retry-independent instead of merely order-lucky.
 */
export const LOCAL_E2E_ONBOARDING_APP_SLUGS = Object.freeze({
  emptyState: "onboarding-api",
  connect: "onboarding-connect",
  verify: "onboarding-verify",
  exposure: "onboarding-exposure",
});

const onboardingApps = Object.values(LOCAL_E2E_ONBOARDING_APP_SLUGS).map((slug) => ({
  slug,
  appId: `app_${slug.replaceAll("-", "_")}_e2e`,
  environmentId: `env_${slug.replaceAll("-", "_")}_prod_e2e`,
}));

export function localE2eSession(expiresAt = Math.floor(Date.now() / 1000) + 3_600) {
  return {
    version: 2,
    userId: "user_local_e2e",
    expiresAt,
    workosSessionId: "session_local_e2e",
    orgs: [
      {
        orgId: "org_acme_e2e",
        orgSlug: "acme-labs",
        orgRole: "owner",
        isProvisional: false,
        demoExpiresAt: null,
        apps: [
          { appId: "app_checkout_e2e", appSlug: "checkout-api", role: "owner" },
          { appId: "app_billing_e2e", appSlug: "billing-api", role: "admin" },
          { appId: "app_editing_e2e", appSlug: "flag-editing", role: "admin" },
          { appId: "app_promotion_e2e", appSlug: "promotion", role: "admin" },
          ...onboardingApps.map((app) => ({ appId: app.appId, appSlug: app.slug, role: "admin" })),
        ],
      },
      {
        orgId: "org_orbit_e2e",
        orgSlug: "orbit-tools",
        orgRole: "admin",
        isProvisional: false,
        demoExpiresAt: null,
        apps: [{ appId: "app_agent_e2e", appSlug: "agent-console", role: "admin" }],
      },
    ],
  };
}

export function localE2eMemberSession(expiresAt = Math.floor(Date.now() / 1000) + 3_600) {
  return {
    version: 2,
    userId: "user_local_member_e2e",
    expiresAt,
    workosSessionId: "session_local_member_e2e",
    orgs: [
      {
        orgId: "org_acme_e2e",
        orgSlug: "acme-labs",
        orgRole: "member",
        isProvisional: false,
        demoExpiresAt: null,
        apps: [{ appId: "app_checkout_e2e", appSlug: "checkout-api", role: "member" }],
      },
    ],
  };
}

export function localE2eNewcomerSession(expiresAt = Math.floor(Date.now() / 1000) + 3_600) {
  return {
    version: 2,
    userId: "user_local_newcomer_e2e",
    expiresAt,
    workosSessionId: "session_local_newcomer_e2e",
    orgs: [],
  };
}

export const LOCAL_E2E_D1_SEED = `
INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES
  ('org_acme_e2e', 'Acme Labs', 'acme-labs', 'free', 0, '${createdAt}', '${createdAt}'),
  ('org_orbit_e2e', 'Orbit Tools', 'orbit-tools', 'free', 0, '${createdAt}', '${createdAt}');
INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
  ('app_checkout_e2e', 'org_acme_e2e', 'Checkout API', 'checkout-api', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('app_billing_e2e', 'org_acme_e2e', 'Billing API', 'billing-api', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('app_agent_e2e', 'org_orbit_e2e', 'Agent Console', 'agent-console', '${createdAt}', '${createdAt}', 'user_local_e2e');
INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by) VALUES
  ('env_checkout_dev_e2e', 'app_checkout_e2e', 'dev', 'Development', '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_checkout_settings_retry_e2e', 'app_checkout_e2e', 'settings-retry', 'Settings Retry', '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_checkout_overview_e2e', 'app_checkout_e2e', 'overview-changes', 'Overview Changes', '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"confirm","startExperimentRun":"allow"}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_checkout_calm_e2e', 'app_checkout_e2e', 'calm', 'Overview Calm', '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_checkout_prod_e2e', 'app_checkout_e2e', 'prod', 'Production', '{"variantAvailability":"confirm","targetingRolloutValue":"confirm","enabledState":"confirm","startExperimentRun":"confirm"}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_checkout_setup_e2e', 'app_checkout_e2e', 'setup', 'Setup QA', '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"confirm"}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_billing_prod_e2e', 'app_billing_e2e', 'prod', 'Production', '{"variantAvailability":"confirm","targetingRolloutValue":"confirm","enabledState":"confirm","startExperimentRun":"confirm"}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_agent_prod_e2e', 'app_agent_e2e', 'prod', 'Production', '{"variantAvailability":"confirm","targetingRolloutValue":"confirm","enabledState":"confirm","startExperimentRun":"confirm"}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_checkout_create_e2e', 'app_checkout_e2e', 'create-lab', 'Creation Lab', '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_checkout_creategate_e2e', 'app_checkout_e2e', 'create-gated', 'Creation Gated', '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"confirm"}', '${createdAt}', '${createdAt}', 'user_local_e2e');
INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
  ('org_acme_e2e', 'user_local_e2e', 'owner', '${createdAt}'),
  ('org_orbit_e2e', 'user_local_e2e', 'admin', '${createdAt}'),
  ('org_acme_e2e', 'user_local_member_e2e', 'member', '${createdAt}');
INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES
  ('app_checkout_e2e', 'user_local_e2e', 'owner', '${createdAt}'),
  ('app_billing_e2e', 'user_local_e2e', 'admin', '${createdAt}'),
  ('app_agent_e2e', 'user_local_e2e', 'admin', '${createdAt}'),
  ('app_checkout_e2e', 'user_local_member_e2e', 'member', '${createdAt}');
INSERT INTO flags (id, app_id, key, name, schema, default_variant_id, created_at, updated_at, created_by, updated_by) VALUES
  ('flag_checkout_e2e', 'app_checkout_e2e', 'new-checkout', 'New Checkout', '{"type":"boolean"}', 'variant_checkout_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_checkout_significance_e2e', 'app_checkout_e2e', 'checkout-significance', 'Checkout Conversion', '{"type":"boolean"}', 'variant_significance_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_checkout_guardrail_e2e', 'app_checkout_e2e', 'checkout-guardrail', 'Checkout Reliability', '{"type":"boolean"}', 'variant_guardrail_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_checkout_draft_e2e', 'app_checkout_e2e', 'checkout-draft', 'Checkout Draft', '{"type":"boolean"}', 'variant_draft_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_checkout_srm_e2e', 'app_checkout_e2e', 'checkout-srm', 'Checkout Routing', '{"type":"boolean"}', 'variant_srm_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_checkout_ended_e2e', 'app_checkout_e2e', 'checkout-ended', 'Checkout History', '{"type":"boolean"}', 'variant_ended_control_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_agent_e2e', 'app_agent_e2e', 'agent-routing', 'Agent Routing', NULL, NULL, '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e');
INSERT INTO variants (id, flag_id, name, value, created_at) VALUES
  ('variant_checkout_control_e2e', 'flag_checkout_e2e', 'control', 'false', '${createdAt}'),
  ('variant_checkout_treatment_e2e', 'flag_checkout_e2e', 'treatment', 'true', '${createdAt}'),
  ('variant_significance_control_e2e', 'flag_checkout_significance_e2e', 'control', 'false', '${createdAt}'),
  ('variant_significance_treatment_e2e', 'flag_checkout_significance_e2e', 'treatment', 'true', '${createdAt}'),
  ('variant_guardrail_control_e2e', 'flag_checkout_guardrail_e2e', 'control', 'false', '${createdAt}'),
  ('variant_guardrail_treatment_e2e', 'flag_checkout_guardrail_e2e', 'treatment', 'true', '${createdAt}'),
  ('variant_draft_control_e2e', 'flag_checkout_draft_e2e', 'control', 'false', '${createdAt}'),
  ('variant_ended_control_e2e', 'flag_checkout_ended_e2e', 'control', 'false', '${createdAt}'),
  ('variant_ended_treatment_e2e', 'flag_checkout_ended_e2e', 'treatment', 'true', '${createdAt}'),
  ('variant_srm_control_e2e', 'flag_checkout_srm_e2e', 'control', 'false', '${createdAt}'),
  ('variant_srm_treatment_e2e', 'flag_checkout_srm_e2e', 'treatment', 'true', '${createdAt}');
INSERT INTO flag_configs (id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, created_at, updated_at) VALUES
  ('config_checkout_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_e2e', 1, '["control","treatment"]', 'variant_checkout_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_checkout_prod_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'flag_checkout_e2e', 0, '["control"]', 'variant_checkout_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_checkout_setup_e2e', 'app_checkout_e2e', 'env_checkout_setup_e2e', 'flag_checkout_e2e', 1, '["control","treatment"]', 'variant_checkout_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_significance_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_significance_e2e', 1, '["control","treatment"]', 'variant_significance_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_guardrail_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_guardrail_e2e', 1, '["control","treatment"]', 'variant_guardrail_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_draft_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_draft_e2e', 1, '["control"]', 'variant_draft_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_ended_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_ended_e2e', 1, '["control"]', 'variant_ended_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_srm_prod_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'flag_checkout_srm_e2e', 1, '["control","treatment"]', 'variant_srm_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_checkout_overview_e2e', 'app_checkout_e2e', 'env_checkout_overview_e2e', 'flag_checkout_e2e', 1, '["control","treatment"]', 'variant_checkout_control_e2e', '${createdAt}', '${recentlyChangedAt}'),
  ('config_srm_overview_e2e', 'app_checkout_e2e', 'env_checkout_overview_e2e', 'flag_checkout_srm_e2e', 0, '["control"]', 'variant_srm_control_e2e', '${createdAt}', '${staleChangedAt}'),
  ('config_create_lab_e2e', 'app_checkout_e2e', 'env_checkout_create_e2e', 'flag_checkout_ended_e2e', 1, '["control","treatment"]', 'variant_ended_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_create_gated_e2e', 'app_checkout_e2e', 'env_checkout_creategate_e2e', 'flag_checkout_ended_e2e', 1, '["control","treatment"]', 'variant_ended_control_e2e', '${createdAt}', '${createdAt}');
INSERT INTO metrics (id, app_id, key, name, kind, event_name, created_at, created_by) VALUES
  ('checkout-conversion', 'app_checkout_e2e', 'checkout-conversion', 'Checkout conversion', 'binomial', 'checkout_completed', '${createdAt}', 'user_local_e2e'),
  ('checkout-reliability', 'app_checkout_e2e', 'checkout-reliability', 'Checkout reliability', 'binomial', 'checkout_succeeded', '${createdAt}', 'user_local_e2e'),
  ('metric_setup_goal_e2e', 'app_checkout_e2e', 'setup-goal', 'Checkout conversion', 'binomial', 'checkout_completed', '${createdAt}', 'user_local_e2e'),
  ('metric_setup_secondary_e2e', 'app_checkout_e2e', 'setup-secondary', 'Order value', 'binomial', 'order_value_recorded', '${createdAt}', 'user_local_e2e'),
  ('metric_setup_guardrail_e2e', 'app_checkout_e2e', 'setup-guardrail', 'Checkout errors', 'binomial', 'checkout_error', '${createdAt}', 'user_local_e2e'),
  ('metric_setup_activation_e2e', 'app_checkout_e2e', 'setup-activation', 'Checkout opened', 'binomial', 'checkout_opened', '${createdAt}', 'user_local_e2e');
INSERT INTO experiments (id, app_id, environment_id, key, flag_id, name, status, targeting_key_field, targeting_key_type, default_variant_id, metrics, guardrail_metrics, dimensions, live_run_id, created_at, updated_at, created_by, updated_by) VALUES
  ('experiment_checkout_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-copy-dev', 'flag_checkout_e2e', 'Checkout Copy Dev', 'running', 'targetingKey', 'user', 'variant_checkout_control_e2e', '[]', '[]', '[]', 'run_checkout_dev_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_significance_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-significance', 'flag_checkout_significance_e2e', 'Checkout Conversion Lift', 'running', 'targetingKey', 'user', 'variant_significance_control_e2e', '[{"metricId":"checkout-conversion"}]', '[]', '[]', 'run_checkout_significance_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_guardrail_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-guardrail', 'flag_checkout_guardrail_e2e', 'Checkout Reliability Watch', 'running', 'targetingKey', 'user', 'variant_guardrail_control_e2e', '[]', '[{"metricId":"checkout-reliability"}]', '[]', 'run_checkout_guardrail_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_draft_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-draft', 'flag_checkout_draft_e2e', 'Checkout Draft', 'draft', 'targetingKey', 'user', 'variant_draft_control_e2e', '[]', '[]', '[]', NULL, '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_ended_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-ended', 'flag_checkout_ended_e2e', 'Checkout Baseline', 'ended', 'targetingKey', 'user', 'variant_ended_control_e2e', '[]', '[]', '[]', NULL, '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_prod_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'checkout-copy-prod', 'flag_checkout_e2e', 'Checkout Copy Prod', 'running', 'targetingKey', 'user', 'variant_checkout_control_e2e', '[]', '[]', '[]', 'run_checkout_prod_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_srm_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'checkout-srm', 'flag_checkout_srm_e2e', 'Checkout Routing Split', 'running', 'targetingKey', 'user', 'variant_srm_control_e2e', '[{"metricId":"checkout-conversion"}]', '[]', '[]', 'run_checkout_srm_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_setup_e2e', 'app_checkout_e2e', 'env_checkout_setup_e2e', 'checkout-setup', 'flag_checkout_e2e', 'Checkout Setup Taxonomy', 'running', 'targetingKey', 'user', 'variant_checkout_control_e2e', '${d1RunDecisions("metric_setup_goal_e2e", "metric_setup_secondary_e2e")}', '${d1RunDecisions("metric_setup_guardrail_e2e")}', '[]', 'run_checkout_setup_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_agent_e2e', 'app_agent_e2e', 'env_agent_prod_e2e', 'routing-model', 'flag_agent_e2e', 'Routing Model', 'draft', 'targetingKey', 'user', NULL, '[]', '[]', '[]', NULL, '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e');
INSERT INTO runs (id, app_id, environment_id, experiment_id, run_number, status, targeting_key_field, targeting_key_type, salt, allocation, variant_set, control_variant_id, targeting_rules, activation_metric_id, confidence_level, decision_family, guardrail_decisions, config_hash, started_at, created_at, created_by) VALUES
  ('run_checkout_dev_previous_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_dev_e2e', 1, 'ended', 'targetingKey', 'user', '${run.salt.devPrevious}', '${json(run.allocation.checkout)}', '${json(run.variants.checkout)}', 'variant_checkout_control_e2e', '${json(run.targetingRules)}', NULL, 0.95, '[]', '[]', '${run.hash.devPrevious}', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z', 'user_local_e2e'),
  ('run_checkout_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_dev_e2e', 2, 'running', 'targetingKey', 'user', '${run.salt.dev}', '${json(run.allocation.checkoutExpanded)}', '${json(run.variants.checkout)}', 'variant_checkout_control_e2e', '${json(run.targetingRules)}', NULL, 0.95, '[]', '[]', '${run.hash.dev}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_prod_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'experiment_checkout_prod_e2e', 1, 'running', 'targetingKey', 'user', '${run.salt.prod}', '${json(run.allocation.checkout)}', '${json(run.variants.checkout)}', 'variant_checkout_control_e2e', '${json(run.targetingRules)}', NULL, 0.95, '[]', '[]', '${run.hash.prod}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_setup_e2e', 'app_checkout_e2e', 'env_checkout_setup_e2e', 'experiment_checkout_setup_e2e', 1, 'running', 'targetingKey', 'user', '${run.salt.setup}', '${json(run.allocation.checkout)}', '${json(run.variants.checkout)}', 'variant_checkout_control_e2e', '${json(run.targetingRules)}', NULL, 0.95, '${d1RunDecisions("metric_setup_goal_e2e")}', '${d1RunDecisions("metric_setup_guardrail_e2e")}', '${run.hash.setup}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_significance_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_significance_e2e', 1, 'running', 'targetingKey', 'user', '${run.salt.significance}', '${json(run.allocation.checkout)}', '${json(run.variants.significance)}', 'variant_significance_control_e2e', '${json(run.targetingRules)}', NULL, 0.95, '${d1RunDecisions("checkout-conversion")}', '[]', '${run.hash.significance}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_guardrail_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_guardrail_e2e', 1, 'running', 'targetingKey', 'user', '${run.salt.guardrail}', '${json(run.allocation.checkout)}', '${json(run.variants.guardrail)}', 'variant_guardrail_control_e2e', '${json(run.targetingRules)}', NULL, 0.95, '[]', '${d1RunDecisions("checkout-reliability")}', '${run.hash.guardrail}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_srm_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'experiment_checkout_srm_e2e', 1, 'running', 'targetingKey', 'user', '${run.salt.srm}', '${json(run.allocation.checkout)}', '${json(run.variants.srm)}', 'variant_srm_control_e2e', '${json(run.targetingRules)}', NULL, 0.95, '${d1RunDecisions("checkout-conversion")}', '[]', '${run.hash.srm}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_ended_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_ended_e2e', 1, 'ended', 'targetingKey', 'user', '${run.salt.ended}', '${json(run.allocation.checkout)}', '${json(run.variants.ended)}', 'variant_ended_control_e2e', '${json(run.targetingRules)}', NULL, 0.95, '[]', '[]', '${run.hash.ended}', '${createdAt}', '${createdAt}', 'user_local_e2e');
UPDATE runs SET ended_at = '2026-07-17T12:00:00.000Z', end_reason = 'Prepared a larger treatment allocation' WHERE id = 'run_checkout_dev_previous_e2e';
UPDATE runs SET start_reason = 'Increase treatment traffic' WHERE id = 'run_checkout_dev_e2e';
UPDATE experiments SET description = 'A dedicated Setup-tab acceptance fixture', owner = 'growth', tags = '["checkout","setup"]', activation_metric_id = 'metric_setup_activation_e2e', conversion_window_ms = 86400000 WHERE id = 'experiment_checkout_setup_e2e';
UPDATE runs SET activation_metric_id = 'metric_setup_activation_e2e' WHERE id = 'run_checkout_setup_e2e';

-- Apps reserved for the onboarding journey. They must stay empty: the teaching
-- empty states can only be asserted somewhere no other spec writes, and Flags are
-- App-scoped, so a shared App loses its empty state the moment another spec
-- creates a Flag in it. One per onboarding test, so the spec does not depend on
-- its own execution order (see LOCAL_E2E_ONBOARDING_APP_SLUGS).
INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
${onboardingApps
  .map(
    (app) =>
      `  ('${app.appId}', 'org_acme_e2e', '${app.slug}', '${app.slug}', '${createdAt}', '${createdAt}', 'user_local_e2e')`,
  )
  .join(",\n")};
INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by) VALUES
${onboardingApps
  .map(
    (app) =>
      `  ('${app.environmentId}', '${app.appId}', 'prod', 'Production', '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}', '${createdAt}', '${createdAt}', 'user_local_e2e')`,
  )
  .join(",\n")};
INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES
${onboardingApps
  .map((app) => `  ('${app.appId}', 'user_local_e2e', 'admin', '${createdAt}')`)
  .join(",\n")};
${LOCAL_E2E_FLAG_EDITING_SEED}
${LOCAL_E2E_PROMOTION_SEED}`;
