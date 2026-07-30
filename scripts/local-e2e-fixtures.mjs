import { createHash } from "node:crypto";

export const LOCAL_E2E_SESSION_TOKEN = `spl_${"101e2e".padEnd(64, "0")}`;
export const LOCAL_E2E_SESSION_KEY = `session:${createHash("sha256")
  .update(LOCAL_E2E_SESSION_TOKEN)
  .digest("hex")}`;
export const LOCAL_E2E_MEMBER_SESSION_TOKEN = `spl_${"141e2e".padEnd(64, "0")}`;
export const LOCAL_E2E_MEMBER_SESSION_KEY = `session:${createHash("sha256")
  .update(LOCAL_E2E_MEMBER_SESSION_TOKEN)
  .digest("hex")}`;

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

export const LOCAL_E2E_ANALYSIS_INPUTS = Object.freeze([
  analysisInput("env_checkout_dev_e2e", "experiment_checkout_dev_e2e", "run_checkout_dev_e2e", {
    control: 10,
    treatment: 10,
  }),
  analysisInput("env_checkout_prod_e2e", "experiment_checkout_prod_e2e", "run_checkout_prod_e2e", {
    control: 19,
    treatment: 1,
  }),
  analysisInput(
    "env_checkout_dev_e2e",
    "experiment_checkout_significance_e2e",
    "run_checkout_significance_e2e",
    { control: 100, treatment: 100 },
    { decisionMetric: "checkout-conversion", conversions: { control: 5, treatment: 80 } },
  ),
  analysisInput(
    "env_checkout_dev_e2e",
    "experiment_checkout_guardrail_e2e",
    "run_checkout_guardrail_e2e",
    { control: 100, treatment: 100 },
    {
      guardrailMetric: "checkout-reliability",
      conversions: { control: 80, treatment: 10 },
    },
  ),
]);

const createdAt = "2026-07-18T00:00:00.000Z";
const checkoutVariants = [
  { id: "variant_checkout_control_e2e", name: "control", value: false },
  { id: "variant_checkout_treatment_e2e", name: "treatment", value: true },
];
const significanceVariants = [
  { id: "variant_significance_control_e2e", name: "control", value: false },
  { id: "variant_significance_treatment_e2e", name: "treatment", value: true },
];
const guardrailVariants = [
  { id: "variant_guardrail_control_e2e", name: "control", value: false },
  { id: "variant_guardrail_treatment_e2e", name: "treatment", value: true },
];
const endedVariants = [
  { id: "variant_ended_control_e2e", name: "control", value: false },
  { id: "variant_ended_treatment_e2e", name: "treatment", value: true },
];
const checkoutAllocation = { control: 50, treatment: 50 };
const checkoutExpandedAllocation = { control: 70, treatment: 30 };
const checkoutTargetingRules = [];
const devRunSalt = "local-e2e-dev";
const devPreviousRunSalt = "local-e2e-dev-previous";
const prodRunSalt = "local-e2e-prod";
const devRunHash = runConfigHash(devRunSalt, checkoutExpandedAllocation);
const devPreviousRunHash = runConfigHash(devPreviousRunSalt);
const prodRunHash = runConfigHash(prodRunSalt);
const significanceRunSalt = "local-e2e-significance";
const guardrailRunSalt = "local-e2e-guardrail";
const endedRunSalt = "local-e2e-ended";
const significanceRunHash = runConfigHash(
  significanceRunSalt,
  checkoutAllocation,
  significanceVariants,
);
const guardrailRunHash = runConfigHash(guardrailRunSalt, checkoutAllocation, guardrailVariants);
const endedRunHash = runConfigHash(endedRunSalt, checkoutAllocation, endedVariants);

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

export const LOCAL_E2E_D1_SEED = `
INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES
  ('org_acme_e2e', 'Acme Labs', 'acme-labs', 'free', 0, '${createdAt}', '${createdAt}'),
  ('org_orbit_e2e', 'Orbit Tools', 'orbit-tools', 'free', 0, '${createdAt}', '${createdAt}');
INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
  ('app_checkout_e2e', 'org_acme_e2e', 'Checkout API', 'checkout-api', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('app_billing_e2e', 'org_acme_e2e', 'Billing API', 'billing-api', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('app_agent_e2e', 'org_orbit_e2e', 'Agent Console', 'agent-console', '${createdAt}', '${createdAt}', 'user_local_e2e');
INSERT INTO environments (id, app_id, key, name, created_at, updated_at, created_by) VALUES
  ('env_checkout_dev_e2e', 'app_checkout_e2e', 'dev', 'Development', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_checkout_prod_e2e', 'app_checkout_e2e', 'prod', 'Production', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_billing_prod_e2e', 'app_billing_e2e', 'prod', 'Production', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_agent_prod_e2e', 'app_agent_e2e', 'prod', 'Production', '${createdAt}', '${createdAt}', 'user_local_e2e');
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
  ('variant_ended_treatment_e2e', 'flag_checkout_ended_e2e', 'treatment', 'true', '${createdAt}');
INSERT INTO flag_configs (id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, created_at, updated_at) VALUES
  ('config_checkout_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_e2e', 1, '["control","treatment"]', 'variant_checkout_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_checkout_prod_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'flag_checkout_e2e', 0, '["control"]', 'variant_checkout_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_significance_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_significance_e2e', 1, '["control","treatment"]', 'variant_significance_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_guardrail_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_guardrail_e2e', 1, '["control","treatment"]', 'variant_guardrail_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_draft_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_draft_e2e', 1, '["control"]', 'variant_draft_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_ended_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_ended_e2e', 1, '["control"]', 'variant_ended_control_e2e', '${createdAt}', '${createdAt}');
INSERT INTO metrics (id, app_id, key, name, kind, event_name, created_at, created_by) VALUES
  ('checkout-conversion', 'app_checkout_e2e', 'checkout-conversion', 'Checkout conversion', 'binomial', 'checkout_completed', '${createdAt}', 'user_local_e2e'),
  ('checkout-reliability', 'app_checkout_e2e', 'checkout-reliability', 'Checkout reliability', 'binomial', 'checkout_succeeded', '${createdAt}', 'user_local_e2e');
INSERT INTO experiments (id, app_id, environment_id, key, flag_id, name, status, targeting_key_field, targeting_key_type, default_variant_id, metrics, guardrail_metrics, dimensions, live_run_id, created_at, updated_at, created_by, updated_by) VALUES
  ('experiment_checkout_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-copy-dev', 'flag_checkout_e2e', 'Checkout Copy Dev', 'running', 'targetingKey', 'user', 'variant_checkout_control_e2e', '[]', '[]', '[]', 'run_checkout_dev_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_significance_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-significance', 'flag_checkout_significance_e2e', 'Checkout Conversion Lift', 'running', 'targetingKey', 'user', 'variant_significance_control_e2e', '[{"metricId":"checkout-conversion"}]', '[]', '[]', 'run_checkout_significance_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_guardrail_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-guardrail', 'flag_checkout_guardrail_e2e', 'Checkout Reliability Watch', 'running', 'targetingKey', 'user', 'variant_guardrail_control_e2e', '[]', '[{"metricId":"checkout-reliability"}]', '[]', 'run_checkout_guardrail_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_draft_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-draft', 'flag_checkout_draft_e2e', 'Checkout Draft', 'draft', 'targetingKey', 'user', 'variant_draft_control_e2e', '[]', '[]', '[]', NULL, '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_ended_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-ended', 'flag_checkout_ended_e2e', 'Checkout Baseline', 'ended', 'targetingKey', 'user', 'variant_ended_control_e2e', '[]', '[]', '[]', NULL, '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_prod_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'checkout-copy-prod', 'flag_checkout_e2e', 'Checkout Copy Prod', 'running', 'targetingKey', 'user', 'variant_checkout_control_e2e', '[]', '[]', '[]', 'run_checkout_prod_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_agent_e2e', 'app_agent_e2e', 'env_agent_prod_e2e', 'routing-model', 'flag_agent_e2e', 'Routing Model', 'draft', 'targetingKey', 'user', NULL, '[]', '[]', '[]', NULL, '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e');
INSERT INTO runs (id, app_id, environment_id, experiment_id, run_number, status, targeting_key_field, targeting_key_type, salt, allocation, variant_set, control_variant_id, targeting_rules, confidence_level, decision_family, guardrail_decisions, config_hash, started_at, created_at, created_by) VALUES
  ('run_checkout_dev_previous_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_dev_e2e', 1, 'ended', 'targetingKey', 'user', '${devPreviousRunSalt}', '${JSON.stringify(checkoutAllocation)}', '${JSON.stringify(checkoutVariants)}', 'variant_checkout_control_e2e', '${JSON.stringify(checkoutTargetingRules)}', 0.95, '[]', '[]', '${devPreviousRunHash}', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z', 'user_local_e2e'),
  ('run_checkout_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_dev_e2e', 2, 'running', 'targetingKey', 'user', '${devRunSalt}', '${JSON.stringify(checkoutExpandedAllocation)}', '${JSON.stringify(checkoutVariants)}', 'variant_checkout_control_e2e', '${JSON.stringify(checkoutTargetingRules)}', 0.95, '[]', '[]', '${devRunHash}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_prod_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'experiment_checkout_prod_e2e', 1, 'running', 'targetingKey', 'user', '${prodRunSalt}', '${JSON.stringify(checkoutAllocation)}', '${JSON.stringify(checkoutVariants)}', 'variant_checkout_control_e2e', '${JSON.stringify(checkoutTargetingRules)}', 0.95, '[]', '[]', '${prodRunHash}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_significance_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_significance_e2e', 1, 'running', 'targetingKey', 'user', '${significanceRunSalt}', '${JSON.stringify(checkoutAllocation)}', '${JSON.stringify(significanceVariants)}', 'variant_significance_control_e2e', '${JSON.stringify(checkoutTargetingRules)}', 0.95, '[{"metric_id":"checkout-conversion","variant":"treatment"}]', '[]', '${significanceRunHash}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_guardrail_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_guardrail_e2e', 1, 'running', 'targetingKey', 'user', '${guardrailRunSalt}', '${JSON.stringify(checkoutAllocation)}', '${JSON.stringify(guardrailVariants)}', 'variant_guardrail_control_e2e', '${JSON.stringify(checkoutTargetingRules)}', 0.95, '[]', '[{"metric_id":"checkout-reliability","variant":"treatment","downside_threshold":-10,"guardrail_locked_at_run_start":true,"threshold_locked_at_run_start":true}]', '${guardrailRunHash}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_ended_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_ended_e2e', 1, 'ended', 'targetingKey', 'user', '${endedRunSalt}', '${JSON.stringify(checkoutAllocation)}', '${JSON.stringify(endedVariants)}', 'variant_ended_control_e2e', '${JSON.stringify(checkoutTargetingRules)}', 0.95, '[]', '[]', '${endedRunHash}', '${createdAt}', '${createdAt}', 'user_local_e2e');
UPDATE runs SET ended_at = '2026-07-17T12:00:00.000Z', end_reason = 'Prepared a larger treatment allocation' WHERE id = 'run_checkout_dev_previous_e2e';
UPDATE runs SET start_reason = 'Increase treatment traffic' WHERE id = 'run_checkout_dev_e2e';
`;

function analysisInput(environmentId, experimentId, runId, counts, options = {}) {
  const decisionFamily = options.decisionMetric
    ? [{ metric_id: options.decisionMetric, variant: "treatment" }]
    : [];
  const guardrailDecisions = options.guardrailMetric
    ? [
        {
          metric_id: options.guardrailMetric,
          variant: "treatment",
          downside_threshold: -10,
          guardrail_locked_at_run_start: true,
          threshold_locked_at_run_start: true,
        },
      ]
    : [];
  const metricId = options.decisionMetric ?? options.guardrailMetric;
  return {
    appId: "app_checkout_e2e",
    environmentId,
    experimentId,
    runId,
    counts,
    decisionFamily,
    guardrailDecisions,
    exposures: Object.entries(counts).flatMap(([variant, count]) =>
      Array.from({ length: count }, (_, index) => ({
        app_id: "app_checkout_e2e",
        targeting_key_hash: `${environmentId}-${variant}-${index}`,
        environment_id: environmentId,
        id_type: "user",
        run_id: runId,
        variant,
        first_exposure_ts: "2026-07-18T00:00:00.000Z",
        window_anchor: "2026-07-18T00:00:00.000Z",
        dimension_values: "{}",
      })),
    ),
    metricValues: metricId
      ? Object.entries(options.conversions ?? {}).flatMap(([variant, count]) =>
          Array.from({ length: count }, (_, index) => ({
            targeting_key_hash: `${environmentId}-${variant}-${index}`,
            run_id: runId,
            metric_id: metricId,
            metric_type: "binomial",
            value: 1,
            in_window: 1,
          })),
        )
      : [],
  };
}

function runConfigHash(salt, allocation = checkoutAllocation, variantSet = checkoutVariants) {
  const config = {
    salt,
    allocation,
    variantSet,
    targetingRules: checkoutTargetingRules,
  };
  return `sha256:${createHash("sha256").update(stableStringify(config)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
