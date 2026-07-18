import { createHash } from "node:crypto";

export const LOCAL_E2E_SESSION_TOKEN = `spl_${"101e2e".padEnd(64, "0")}`;
export const LOCAL_E2E_SESSION_KEY = `session:${createHash("sha256")
  .update(LOCAL_E2E_SESSION_TOKEN)
  .digest("hex")}`;

const createdAt = "2026-07-18T00:00:00.000Z";

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
        apps: [{ appId: "app_checkout_e2e", appSlug: "checkout-api", role: "owner" }],
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

export const LOCAL_E2E_D1_SEED = `
INSERT INTO organizations (id, name, plan, is_provisional, created_at, updated_at) VALUES
  ('org_acme_e2e', 'Acme Labs', 'free', 0, '${createdAt}', '${createdAt}'),
  ('org_orbit_e2e', 'Orbit Tools', 'free', 0, '${createdAt}', '${createdAt}');
INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
  ('app_checkout_e2e', 'org_acme_e2e', 'Checkout API', 'checkout-api', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('app_agent_e2e', 'org_orbit_e2e', 'Agent Console', 'agent-console', '${createdAt}', '${createdAt}', 'user_local_e2e');
INSERT INTO environments (id, app_id, key, name, created_at, updated_at, created_by) VALUES
  ('env_checkout_dev_e2e', 'app_checkout_e2e', 'dev', 'Development', '${createdAt}', '${createdAt}', 'user_local_e2e'),
  ('env_agent_prod_e2e', 'app_agent_e2e', 'prod', 'Production', '${createdAt}', '${createdAt}', 'user_local_e2e');
INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
  ('org_acme_e2e', 'user_local_e2e', 'owner', '${createdAt}'),
  ('org_orbit_e2e', 'user_local_e2e', 'admin', '${createdAt}');
INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES
  ('app_checkout_e2e', 'user_local_e2e', 'owner', '${createdAt}'),
  ('app_agent_e2e', 'user_local_e2e', 'admin', '${createdAt}');
INSERT INTO flags (id, app_id, key, name, created_at, updated_at, created_by, updated_by) VALUES
  ('flag_checkout_e2e', 'app_checkout_e2e', 'new-checkout', 'New Checkout', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('flag_agent_e2e', 'app_agent_e2e', 'agent-routing', 'Agent Routing', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e');
INSERT INTO experiments (id, app_id, environment_id, key, flag_id, name, targeting_key_field, targeting_key_type, metrics, guardrail_metrics, dimensions, created_at, updated_at, created_by, updated_by) VALUES
  ('experiment_checkout_e2e', 'app_checkout_e2e', 'env_checkout_dev_e2e', 'checkout-copy', 'flag_checkout_e2e', 'Checkout Copy', 'targetingKey', 'string', '[]', '[]', '[]', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e'),
  ('experiment_agent_e2e', 'app_agent_e2e', 'env_agent_prod_e2e', 'routing-model', 'flag_agent_e2e', 'Routing Model', 'targetingKey', 'string', '[]', '[]', '[]', '${createdAt}', '${createdAt}', 'user_local_e2e', 'user_local_e2e');
`;
