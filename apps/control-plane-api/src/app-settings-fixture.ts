import { createLocalD1 } from "@splitch/db/test-d1";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { seedAppMember, seedOrgApp, seedOrgMember } from "./test-seeds";

/**
 * Two Organizations that share nothing but a single deliberately-shared user id.
 *
 * The roles, ids, and member sets are asymmetric on purpose: a fixture where
 * both tenants look alike cannot tell a correctly scoped write from one that
 * hit both rows. `USER_BOTH` is a member in Alpha and an owner in Beta, so any
 * write that leaks across `app_id` changes a row a test can see.
 */

export const ALPHA = {
  orgId: "org_alpha",
  appId: "app_alpha",
  appKey: "alpha-app",
} as const;

export const BETA = {
  orgId: "org_beta",
  appId: "app_beta",
  appKey: "beta-app",
} as const;

const NOW = "2026-08-07T00:00:00.000Z";

export const USER_OWNER = "user_alpha_owner";
export const USER_ADMIN = "user_alpha_admin";
export const USER_MEMBER = "user_alpha_member";
/** In the Alpha Organization, but with no access to the Alpha App. */
export const USER_CANDIDATE = "user_alpha_candidate";
/** In neither Organization. */
export const USER_OUTSIDER = "user_outsider";
export const USER_BOTH = "user_in_both_apps";
export const USER_BETA_OWNER = "user_beta_owner";

export async function seedTwoTenants() {
  const local = await createLocalD1();
  const { d1 } = local;

  await seedOrgApp(d1, {
    orgId: ALPHA.orgId,
    orgName: "Alpha",
    appId: ALPHA.appId,
    appName: "Alpha App",
    appKey: ALPHA.appKey,
  });
  await seedOrgApp(d1, {
    orgId: BETA.orgId,
    orgName: "Beta",
    appId: BETA.appId,
    appName: "Beta App",
    appKey: BETA.appKey,
  });

  for (const [userId, role] of [
    [USER_OWNER, "owner"],
    [USER_ADMIN, "admin"],
    [USER_MEMBER, "member"],
    [USER_CANDIDATE, "member"],
    [USER_BOTH, "member"],
  ] as const) {
    await seedOrgMember(d1, { orgId: ALPHA.orgId, userId, role });
  }
  for (const [userId, role] of [
    [USER_BETA_OWNER, "owner"],
    [USER_BOTH, "owner"],
  ] as const) {
    await seedOrgMember(d1, { orgId: BETA.orgId, userId, role });
  }

  for (const [userId, role] of [
    [USER_OWNER, "owner"],
    [USER_ADMIN, "admin"],
    [USER_MEMBER, "member"],
    [USER_BOTH, "member"],
  ] as const) {
    await seedAppMember(d1, { appId: ALPHA.appId, userId, role });
  }
  for (const [userId, role] of [
    [USER_BETA_OWNER, "owner"],
    [USER_BOTH, "owner"],
  ] as const) {
    await seedAppMember(d1, { appId: BETA.appId, userId, role });
  }

  return local;
}

/**
 * A principal whose token scopes claim EVERY App role on the target App.
 *
 * The scopes are deliberately maximal so no refusal below can come from the
 * claim: whatever the handler refuses, it refuses on live `app_memberships`
 * read for this call. Stale-claim authorization is exactly what these tests
 * exist to forbid.
 */
export function principalFor(userId: string, appId: string): HandlerArgs<unknown>["principal"] {
  return {
    kind: "control-plane-token",
    id: userId,
    scopes: [`app:${appId}:owner`, `app:${appId}:admin`, `app:${appId}:member`],
    orgId: null,
    appId,
    environmentId: null,
    authDoor: null,
  };
}

export function args(
  userId: string,
  appId: string,
  input: { params?: Record<string, string>; body?: Record<string, unknown> },
): HandlerArgs<unknown> {
  return {
    input: { params: { appId, ...input.params }, ...(input.body ? { body: input.body } : {}) },
    principal: principalFor(userId, appId),
    requestId: "req_test",
    request: new Request("https://control-plane.test/binding"),
  };
}

/**
 * The Organization-scoped twin of `args`, for routes that name an Org and no
 * App. The scopes are maximal for the same reason: any refusal has to come from
 * the live `organization_members` read, not from the claim.
 */
export function orgArgs(
  userId: string,
  orgId: string,
  input: { params?: Record<string, string>; body?: Record<string, unknown> },
): HandlerArgs<unknown> {
  return {
    input: { params: { orgId, ...input.params }, ...(input.body ? { body: input.body } : {}) },
    principal: {
      kind: "control-plane-token",
      id: userId,
      scopes: [`org:${orgId}:owner`, `org:${orgId}:admin`, `org:${orgId}:member`],
      orgId,
      appId: null,
      environmentId: null,
      authDoor: null,
    },
    requestId: "req_test",
    request: new Request("https://control-plane.test/binding"),
  };
}

export interface SeedFlag {
  appId: string;
  flagId: string;
  key: string;
  name: string;
  variants: readonly { id: string; name: string; value: string }[];
  defaultVariantId?: string;
}

/** A Flag and its Variant catalog, the App-level definition Settings shows. */
export async function seedFlag(d1: D1Database, flag: SeedFlag): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO flags (id, app_id, key, name, default_variant_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(flag.flagId, flag.appId, flag.key, flag.name, flag.defaultVariantId ?? null, NOW, NOW)
    .run();
  for (const variant of flag.variants) {
    await d1
      .prepare("INSERT INTO variants (id, flag_id, name, value, created_at) VALUES (?,?,?,?,?)")
      .bind(variant.id, flag.flagId, variant.name, variant.value, NOW)
      .run();
  }
}

export async function errorCode(response: Response): Promise<string> {
  const payload = (await response.json()) as { code?: string };
  return payload.code ?? "";
}
