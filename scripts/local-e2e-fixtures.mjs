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

export const LOCAL_E2E_ANALYSIS_RESULTS = Object.freeze([
  analysisResult("env_checkout_dev_e2e", "experiment_checkout_dev_e2e", false),
  analysisResult("env_checkout_prod_e2e", "experiment_checkout_prod_e2e", true),
]);

const createdAt = "2026-07-18T00:00:00.000Z";
const checkoutVariants = [
  { id: "variant_checkout_control_e2e", name: "control", value: false },
  { id: "variant_checkout_treatment_e2e", name: "treatment", value: true },
];
const checkoutAllocation = { control: 50, treatment: 50 };
const checkoutTargetingRules = [];
const devRunSalt = "local-e2e-dev";
const prodRunSalt = "local-e2e-prod";
const devRunHash = runConfigHash(devRunSalt);
const prodRunHash = runConfigHash(prodRunSalt);

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
INSERT INTO organizations (id, name, plan, is_provisional, created_at, updated_at) VALUES
  ('org_acme_e2e', 'Acme Labs', 'free', 0, '${createdAt}', '${createdAt}'),
  ('org_orbit_e2e', 'Orbit Tools', 'free', 0, '${createdAt}', '${createdAt}');
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
  ('flag_agent_e2e', 'app_agent_e2e', 'agent-routing', 'Agent Routing', NULL, NULL, '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e');
INSERT INTO variants (id, flag_id, name, value, created_at) VALUES
  ('variant_checkout_control_e2e', 'flag_checkout_e2e', 'control', 'false', '${createdAt}'),
  ('variant_checkout_treatment_e2e', 'flag_checkout_e2e', 'treatment', 'true', '${createdAt}');
INSERT INTO flag_configs (id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, created_at, updated_at) VALUES
  ('config_checkout_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'flag_checkout_e2e', 1, '["control","treatment"]', 'variant_checkout_control_e2e', '${createdAt}', '${createdAt}'),
  ('config_checkout_prod_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'flag_checkout_e2e', 1, '["control","treatment"]', 'variant_checkout_control_e2e', '${createdAt}', '${createdAt}');
INSERT INTO experiments (id, app_id, environment_id, key, flag_id, name, status, targeting_key_field, targeting_key_type, default_variant_id, metrics, guardrail_metrics, dimensions, live_run_id, created_at, updated_at, created_by, updated_by) VALUES
  ('experiment_checkout_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-copy-dev', 'flag_checkout_e2e', 'Checkout Copy Dev', 'running', 'targetingKey', 'user', 'variant_checkout_control_e2e', '[]', '[]', '[]', 'run_checkout_dev_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_checkout_prod_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'checkout-copy-prod', 'flag_checkout_e2e', 'Checkout Copy Prod', 'running', 'targetingKey', 'user', 'variant_checkout_control_e2e', '[]', '[]', '[]', 'run_checkout_prod_e2e', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_agent_e2e', 'app_agent_e2e', 'env_agent_prod_e2e', 'routing-model', 'flag_agent_e2e', 'Routing Model', 'draft', 'targetingKey', 'user', NULL, '[]', '[]', '[]', NULL, '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e');
INSERT INTO runs (id, app_id, environment_id, experiment_id, run_number, status, targeting_key_field, targeting_key_type, salt, allocation, variant_set, targeting_rules, confidence_level, decision_family, guardrail_decisions, config_hash, started_at, created_at, created_by) VALUES
  ('run_checkout_dev_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'experiment_checkout_dev_e2e', 1, 'running', 'targetingKey', 'user', '${devRunSalt}', '${JSON.stringify(checkoutAllocation)}', '${JSON.stringify(checkoutVariants)}', '${JSON.stringify(checkoutTargetingRules)}', 0.95, '[]', '[]', '${devRunHash}', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('run_checkout_prod_e2e', 'app_checkout_e2e', 'env_checkout_prod_e2e', 'experiment_checkout_prod_e2e', 1, 'running', 'targetingKey', 'user', '${prodRunSalt}', '${JSON.stringify(checkoutAllocation)}', '${JSON.stringify(checkoutVariants)}', '${JSON.stringify(checkoutTargetingRules)}', 0.95, '[]', '[]', '${prodRunHash}', '${createdAt}', '${createdAt}', 'user_local_e2e');
`;

function analysisResult(environmentId, experimentId, mismatch) {
  const counts = mismatch ? { control: 19, treatment: 1 } : { control: 10, treatment: 10 };
  return {
    storageKey: `local-e2e:analysis-result:app_checkout_e2e:${environmentId}:${experimentId}`,
    appId: "app_checkout_e2e",
    environmentId,
    experimentId,
    result: {
      arm_results: [],
      srm: {
        srm_p_value: mismatch ? 0.0001 : 0.5,
        srm_is_mismatch: mismatch,
        observed_counts: counts,
        expected_counts: { control: 10, treatment: 10 },
        activated_srm_p_value: null,
        activated_srm_mismatch: null,
      },
      guardrail_results: [],
      health: {
        multiple_rate: 0,
        multiple_count: 0,
        activation_rates: null,
        activation_balance_p_value: null,
        activation_balance_mismatch: null,
        exposure_counts: counts,
        deduped_counts: counts,
        low_n_warning: true,
      },
    },
  };
}

function runConfigHash(salt) {
  const config = {
    salt,
    allocation: checkoutAllocation,
    variantSet: checkoutVariants,
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
