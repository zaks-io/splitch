import { appScope, createRepository, envScope } from "@splitch/db";
import { expect } from "vitest";
import type { Harness } from "../src/config-store-harness-core";
import { appAdminScope } from "../src/scope-binding";
import { seedAppMember } from "../src/test-seeds";
import { confirmPolicy } from "./approval-harness";

/**
 * A second tenant whose every id and value differs from tenant A's fixture
 * graph, so cross-tenant leakage shows up as a foreign value rather than as a
 * coincidentally-equal fixture. Identical seeds on both sides mask isolation
 * bugs by construction.
 */
export const B = {
  orgId: "org_beta_9271",
  orgSlug: "beta-tenant-9271",
  appId: "app_beta_9271",
  envId: "env_beta_stage_9271",
  flagId: "flag_beta_pricing_9271",
  flagKey: "beta-pricing-9271",
  configId: "flag_config_beta_pricing_9271",
  alphaVariantId: "var_beta_alpha_9271",
  omegaVariantId: "var_beta_omega_9271",
  userId: "user_beta_admin_9271",
};

const NOW_B = "2026-07-02T11:22:33.000Z";

export async function seedTenantB(h: Harness): Promise<void> {
  const repo = createRepository(h.d1);
  await repo.identity.createOrganization({
    organization: {
      id: B.orgId,
      name: "Beta Tenant 9271",
      slug: B.orgSlug,
      plan: "free",
      createdAt: NOW_B,
      updatedAt: NOW_B,
    },
    ownerUserId: B.userId,
    createdAt: NOW_B,
  });
  await repo.identity.createApp({
    id: B.appId,
    organizationId: B.orgId,
    name: "Beta App 9271",
    key: "beta-app-9271",
    createdAt: NOW_B,
    updatedAt: NOW_B,
  });
  await repo.identity.environments.insert(appScope(B.appId), {
    id: B.envId,
    appId: B.appId,
    key: "staging",
    name: "Beta Staging",
    policy: JSON.stringify(confirmPolicy),
    createdAt: NOW_B,
    updatedAt: NOW_B,
  });
  await repo.flags.flags.insert(appScope(B.appId), {
    id: B.flagId,
    appId: B.appId,
    key: B.flagKey,
    name: "Beta pricing 9271",
    defaultVariantId: B.alphaVariantId,
    createdAt: NOW_B,
    updatedAt: NOW_B,
  });
  await repo.flags.addVariant(appScope(B.appId), B.flagId, {
    id: B.alphaVariantId,
    name: "beta-alpha",
    value: JSON.stringify("alpha-9271"),
    createdAt: NOW_B,
  });
  await repo.flags.addVariant(appScope(B.appId), B.flagId, {
    id: B.omegaVariantId,
    name: "beta-omega",
    value: JSON.stringify("omega-9271"),
    createdAt: NOW_B,
  });
  await repo.flags.flagConfigs.insert(envScope(B.appId, B.envId), {
    id: B.configId,
    appId: B.appId,
    environmentId: B.envId,
    flagId: B.flagId,
    enabled: false,
    availableVariantNames: JSON.stringify(["beta-alpha", "beta-omega"]),
    defaultVariantId: B.alphaVariantId,
    createdAt: NOW_B,
    updatedAt: NOW_B,
  });
  await seedAppMember(h.d1, { appId: B.appId, userId: B.userId, role: "owner" });
}

/** Tenant B proposal (pending) via the served PATCH route, as B's own owner. */
export async function proposeB(h: Harness, idempotencyKey = "idem_beta_9271"): Promise<string> {
  const jwt = await jwtFor(h, B.userId, [appAdminScope(B.appId)]);
  const response = await h.app.request(
    `/apps/${B.appId}/envs/${B.envId}/flags/${B.flagId}/config`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        availableVariantNames: ["beta-alpha"],
      }),
    },
  );
  expect(response.status).toBe(409);
  const body = (await response.json()) as { code: string; details: { approvalRequestId: string } };
  expect(body.code).toBe("APPROVAL_REVIEW_REQUIRED");
  return body.details.approvalRequestId;
}

export async function jwtFor(h: Harness, sub: string, scopes: string[]): Promise<string> {
  return h.signer.sign({
    sub,
    iss: "https://auth.splitch.test",
    aud: "https://cp.splitch.test",
    iat: 1_780_000_000,
    exp: 1_999_999_999,
    scopes,
  });
}

export async function get(h: Harness, path: string, jwt: string): Promise<Response> {
  return h.app.request(path, { headers: { authorization: `Bearer ${jwt}` } });
}

export async function reviewAs(
  h: Harness,
  appId: string,
  requestId: string,
  jwt: string,
  action: "approve_and_apply" | "decline",
  idempotencyKey: string,
): Promise<Response> {
  return h.app.request(`/apps/${appId}/approval-requests/${requestId}/reviews`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ action, idempotency_key: idempotencyKey }),
  });
}
