import { appScope, envScope, type Repository } from "@splitch/db";
import { seedAppMember } from "../src/test-seeds";

const NOW = "2026-07-01T20:00:00.000Z";

export const ALPHA = {
  orgId: "org_alpha_sec495",
  appId: "app_alpha_sec495",
  envId: "env_alpha_prod_sec495",
  flagId: "flag_alpha_checkout_sec495",
  flagKey: "alpha-checkout",
  configId: "cfg_alpha_sec495",
  ruleId: "rule_alpha_sec495",
  controlVariantId: "var_alpha_control_sec495",
  treatmentVariantId: "var_alpha_treatment_sec495",
  controlVariantName: "alpha-control",
  treatmentVariantName: "alpha-treatment",
  ruleAttribute: "alpha_plan",
  ruleValue: "ALPHA-PUBLIC-VALUE",
  salt: "alpha-salt",
  percentage: 11,
  userId: "user_alpha_owner_sec495",
} as const;

export const BRAVO = {
  orgId: "org_bravo_sec495",
  appId: "app_bravo_sec495",
  envId: "env_bravo_prod_sec495",
  flagId: "flag_bravo_billing_sec495",
  flagKey: "bravo-billing",
  configId: "cfg_bravo_sec495",
  ruleId: "rule_bravo_sec495",
  controlVariantId: "var_bravo_control_sec495",
  treatmentVariantId: "var_bravo_treatment_sec495",
  controlVariantName: "bravo-control",
  treatmentVariantName: "bravo-treatment",
  ruleAttribute: "bravo_tier",
  ruleValue: "BRAVO-CONFIDENTIAL-SEGMENT",
  salt: "bravo-salt",
  percentage: 77,
  userId: "user_bravo_owner_sec495",
} as const;

export type Tenant = typeof ALPHA;

export async function seedSecurityTenants(repo: Repository, d1: D1Database): Promise<void> {
  await seedTenant(repo, d1, ALPHA, false);
  await seedTenant(repo, d1, BRAVO, true);
}

async function seedTenant(
  repo: Repository,
  d1: D1Database,
  tenant: Tenant,
  enabled: boolean,
): Promise<void> {
  const app = appScope(tenant.appId);
  const environment = envScope(tenant.appId, tenant.envId);
  await repo.identity.createOrganization({
    organization: {
      id: tenant.orgId,
      name: `${tenant.appId} org`,
      slug: tenant.orgId,
      plan: "free",
      createdAt: NOW,
      updatedAt: NOW,
    },
    ownerUserId: tenant.userId,
    createdAt: NOW,
  });
  await repo.identity.createApp({
    id: tenant.appId,
    organizationId: tenant.orgId,
    name: tenant.appId,
    key: tenant.appId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await seedAppMember(d1, { appId: tenant.appId, userId: tenant.userId, role: "owner" });
  await repo.identity.environments.insert(app, {
    id: tenant.envId,
    appId: tenant.appId,
    key: `${tenant.appId}-prod`,
    name: `${tenant.appId} production`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.flags.insert(app, {
    id: tenant.flagId,
    appId: tenant.appId,
    key: tenant.flagKey,
    name: tenant.flagKey,
    defaultVariantId: tenant.controlVariantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await addVariant(repo, tenant, tenant.controlVariantId, tenant.controlVariantName, "off");
  await addVariant(repo, tenant, tenant.treatmentVariantId, tenant.treatmentVariantName, "on");
  await repo.flags.flagConfigs.insert(environment, {
    id: tenant.configId,
    appId: tenant.appId,
    environmentId: tenant.envId,
    flagId: tenant.flagId,
    enabled,
    availableVariantNames: JSON.stringify([tenant.controlVariantName, tenant.treatmentVariantName]),
    defaultVariantId: tenant.controlVariantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.targetingRules.insert(environment, {
    id: tenant.ruleId,
    appId: tenant.appId,
    environmentId: tenant.envId,
    flagId: tenant.flagId,
    priority: 0,
    conditions: JSON.stringify([
      { attribute: tenant.ruleAttribute, operator: "eq", value: tenant.ruleValue },
    ]),
    variantId: tenant.treatmentVariantId,
    percentageRollout: JSON.stringify({ percentage: tenant.percentage, salt: tenant.salt }),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function addVariant(
  repo: Repository,
  tenant: Tenant,
  id: string,
  name: string,
  value: string,
): Promise<void> {
  await repo.flags.addVariant(appScope(tenant.appId), tenant.flagId, {
    id,
    name,
    value: JSON.stringify(value),
    createdAt: NOW,
  });
}
