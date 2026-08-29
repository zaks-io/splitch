import { appScope, createRepository, envScope } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { resetOrganizationGraph } from "../src/test-seeds";
import { makeTokenMembershipAccess } from "../src/token-membership";
import { makePoolBindings } from "./pool-bindings";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 7, 28, 12, 0, 0);
export const NOW = new Date(NOW_MS).toISOString();
const USER_ID = "user_principal_flags_member";
const OTHER_USER_ID = "user_zzaudit_other";
const allowLimiter: RateLimiter = () => ({ limited: false });

export const PRINCIPAL_APPS = [
  {
    orgId: "org_principal_alpha",
    orgSlug: "alpha-co",
    appId: "app_principal_alpha_checkout",
    appKey: "checkout",
    flagId: "flag_principal_alpha_checkout_tax",
    flagKey: "checkout-tax",
    environmentId: "env_principal_alpha_checkout_prod",
  },
  {
    orgId: "org_principal_alpha",
    orgSlug: "alpha-co",
    appId: "app_principal_alpha_search",
    appKey: "search",
    flagId: "flag_principal_alpha_search_ranking",
    flagKey: "ranking-model",
    environmentId: "env_principal_alpha_search_prod",
  },
  {
    orgId: "org_principal_beta",
    orgSlug: "beta-labs",
    appId: "app_principal_beta_billing",
    appKey: "billing",
    flagId: "flag_principal_beta_billing_invoice",
    flagKey: "invoice-redesign",
    environmentId: "env_principal_beta_billing_prod",
  },
] as const;

export const FOREIGN_APP = {
  orgId: "org_principal_foreign",
  orgSlug: "foreign-inc",
  appId: "app_principal_foreign_admin",
  appKey: "admin",
  flagId: "flag_principal_foreign_admin_access",
  flagKey: "admin-access",
  environmentId: "env_principal_foreign_admin_prod",
} as const;

export const MEMBER_ORG_NONMEMBER_APP = {
  orgId: "org_principal_alpha",
  orgSlug: "alpha-co",
  appId: "app_principal_alpha_private",
  appKey: "private",
  flagId: "flag_principal_alpha_private_internal",
  flagKey: "internal-access",
  environmentId: "env_principal_alpha_private_prod",
} as const;

export interface PrincipalFlagHarness {
  app: ReturnType<typeof createApp>;
  bindings: LocalBindings;
  repo: ReturnType<typeof createRepository>;
  signer: FixtureSigner;
  token: () => Promise<string>;
}

export async function makePrincipalFlagHarness(additionalFlags = 0): Promise<PrincipalFlagHarness> {
  const bindings = await makePoolBindings();
  await resetOrganizationGraph(bindings.d1);
  const repo = createRepository(bindings.d1);

  await seedRoots(bindings.d1);
  for (const orgId of [...new Set(PRINCIPAL_APPS.map((row) => row.orgId))]) {
    await bindings.d1
      .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(orgId, USER_ID, "member", NOW)
      .run();
  }
  for (const row of PRINCIPAL_APPS) {
    await bindings.d1
      .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(row.appId, USER_ID, "member", NOW)
      .run();
  }
  for (const row of [MEMBER_ORG_NONMEMBER_APP, FOREIGN_APP]) {
    await bindings.d1
      .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(row.appId, OTHER_USER_ID, "member", NOW)
      .run();
  }
  for (const row of [...PRINCIPAL_APPS, MEMBER_ORG_NONMEMBER_APP, FOREIGN_APP]) {
    await seedFlag(repo, row);
  }
  for (let index = 0; index < additionalFlags; index += 1) {
    const suffix = String(index).padStart(4, "0");
    await seedFlag(repo, {
      ...PRINCIPAL_APPS[0],
      flagId: `flag_principal_bulk_${suffix}`,
      flagKey: `bulk-${suffix}`,
    });
  }

  const signer = await makeFixtureSigner();
  const app = createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier: makeJwksVerifier({
        issuer: "https://auth.splitch.test",
        fetchJwks: async () => signer.jwks,
        controlPlaneAudience: AUDIENCE,
      }),
      sessions: makeSessionStore(bindings.kv),
      membershipAccess: makeTokenMembershipAccess(repo),
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo,
  });
  return {
    app,
    bindings,
    repo,
    signer,
    token: () =>
      signer.sign({
        sub: USER_ID,
        iss: "https://auth.splitch.test",
        aud: AUDIENCE,
        iat: Math.floor(NOW_MS / 1000),
        exp: Math.floor(NOW_MS / 1000) + 3600,
        scopes: [],
        auth_door: "id_jag",
        authorization: "membership-wide-read",
      }),
  };
}

async function seedRoots(d1: D1Database): Promise<void> {
  const rows = [...PRINCIPAL_APPS, MEMBER_ORG_NONMEMBER_APP, FOREIGN_APP];
  const organizations = new Map(rows.map((row) => [row.orgId, row]));
  for (const row of organizations.values()) {
    await d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(row.orgId, row.orgSlug, row.orgSlug, "free", NOW, NOW)
      .run();
  }
  for (const row of rows) {
    await d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(row.appId, row.orgId, row.appKey, row.appKey, NOW, NOW)
      .run();
  }
}

async function seedFlag(
  repo: ReturnType<typeof createRepository>,
  row:
    | (typeof PRINCIPAL_APPS)[number]
    | typeof MEMBER_ORG_NONMEMBER_APP
    | typeof FOREIGN_APP
    | Record<string, string>,
): Promise<void> {
  const scope = appScope(row.appId);
  const environment = envScope(row.appId, row.environmentId);
  const variantId = `var_${row.flagId}`;
  if (!(await repo.identity.environments.findOne(scope, undefined))) {
    await repo.identity.environments.insert(scope, {
      id: row.environmentId,
      appId: row.appId,
      key: "prod",
      name: "Production",
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  await repo.flags.flags.insert(scope, {
    id: row.flagId,
    appId: row.appId,
    key: row.flagKey,
    name: `Flag ${row.flagKey}`,
    schema: JSON.stringify({ type: "boolean" }),
    defaultVariantId: variantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.addVariant(scope, row.flagId, {
    id: variantId,
    name: `control-${row.flagKey}`,
    value: JSON.stringify(false),
    createdAt: NOW,
  });
  await repo.flags.flagConfigs.insert(environment, {
    id: `cfg_${row.flagId}`,
    appId: row.appId,
    environmentId: row.environmentId,
    flagId: row.flagId,
    availableVariantNames: JSON.stringify([`control-${row.flagKey}`]),
    defaultVariantId: variantId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
