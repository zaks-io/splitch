import { appScope, createRepository, envScope } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { expect } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeMembershipCacheInvalidator } from "../src/membership-cache";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";
import { noOpExposureStatusCleanup } from "./exposure-status-cleanup-fixture";
import { noOpHoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup-fixture";

/** SPL-326 cascade test fixture: two distinct Organizations + App delete helpers. */

export const AUDIENCE = "https://cp.splitch.test";
export const NOW_MS = Date.UTC(2026, 7, 5, 12, 0, 0);
export const NOW_ISO = new Date(NOW_MS).toISOString();

export const ORG = {
  orgId: "org_app_delete_cascade",
  orgName: "App Delete Cascade Co",
  appId: "app_existing_delete_cascade",
  appName: "Existing Delete Cascade App",
  appKey: "existing-delete-cascade",
};

/** Distinct second Organization — isolation proofs must not share ids with ORG (SPL-11). */
export const OTHER = {
  orgId: "org_app_delete_cascade_other",
  orgName: "App Delete Cascade Other Co",
  appId: "app_existing_delete_cascade_other",
  appName: "Existing Delete Cascade Other App",
  appKey: "existing-delete-cascade-other",
};

export const OWNER = "user_app_delete_cascade_owner";
export const OTHER_OWNER = "user_app_delete_cascade_other";

const allowLimiter: RateLimiter = () => ({ limited: false });
const nowSeconds = () => Math.floor(NOW_MS / 1000);

export interface CascadeHarness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
  appToken(appId: string, userId?: string): Promise<string>;
  createDefaultApp(suffix: string): Promise<{
    app: { id: string };
    environments: Array<{ id: string; key: string }>;
  }>;
  seedChildren(
    appId: string,
    environmentId: string,
    suffix: string,
  ): Promise<{
    flagId: string;
    metricId: string;
    experimentId: string;
    segmentId: string;
  }>;
  seedPrivacyLedger(
    appId: string,
    orgId: string,
    suffix: string,
  ): Promise<{ entityHash: string; privacyRequestId: string }>;
  privacyCounts(appId: string, orgId: string): Promise<{ entities: number; requests: number }>;
}

export async function seedCascadeTenants(): Promise<void> {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, ORG);
  await seedOrgMember(bindings.d1, { orgId: ORG.orgId, userId: OWNER, role: "owner" });
  await seedOrgApp(bindings.d1, OTHER);
  await seedOrgMember(bindings.d1, { orgId: OTHER.orgId, userId: OTHER_OWNER, role: "owner" });

  const repo = createRepository(bindings.d1);
  await repo.privacy.entityDeletions.insert(appScope(OTHER.appId), {
    appId: OTHER.appId,
    idType: "user",
    targetingKeyHash: "hash_cascade_other_org",
    deleteBeforeTs: NOW_ISO,
    requestedAt: NOW_ISO,
  });
  await bindings.d1
    .prepare(
      `INSERT INTO privacy_requests (
         request_id, org_id, app_id, request_type, subject_type, subject_ref,
         requested_by, status, received_at, ack_due_at, response_due_at
       ) VALUES (?, ?, ?, 'delete', 'user', ?, ?, 'received', ?, ?, ?)`,
    )
    .bind(
      "prv_cascade_other_org",
      OTHER.orgId,
      OTHER.appId,
      "subject_cascade_other_org",
      OTHER_OWNER,
      NOW_ISO,
      NOW_ISO,
      NOW_ISO,
    )
    .run();
}

async function seedCascadeChildren(
  d1: D1Database,
  appId: string,
  environmentId: string,
  suffix: string,
): Promise<{
  flagId: string;
  metricId: string;
  experimentId: string;
  segmentId: string;
}> {
  const repo = createRepository(d1);
  const flagId = `flag_cascade_${suffix}`;
  const segmentId = `segment_cascade_${suffix}`;
  await repo.flags.flags.insert(appScope(appId), {
    id: flagId,
    appId,
    key: `cascade-${suffix}`,
    name: "Cascade flag",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.flags.flagConfigs.insert(envScope(appId, environmentId), {
    id: `cfg_cascade_${suffix}`,
    appId,
    environmentId,
    flagId,
    enabled: false,
    availableVariantNames: "[]",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.flags.segments.insert(appScope(appId), {
    id: segmentId,
    appId,
    name: `Cascade segment ${suffix}`,
    conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: "paid" }]),
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.experiments.metrics.insert(appScope(appId), {
    id: `metric_cascade_${suffix}`,
    appId,
    key: `cascade-metric-${suffix}`,
    name: "Cascade metric",
    kind: "binomial",
    eventDefinitionId: "purchase",
    eventFieldName: null,
    denominatorMetricId: null,
    createdAt: NOW_ISO,
  });
  await repo.experiments.experiments.insert(envScope(appId, environmentId), {
    id: `exp_cascade_${suffix}`,
    appId,
    environmentId,
    key: `cascade-exp-${suffix}`,
    flagId,
    name: "Cascade experiment",
    status: "ended",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  return {
    flagId,
    metricId: `metric_cascade_${suffix}`,
    experimentId: `exp_cascade_${suffix}`,
    segmentId,
  };
}

async function seedCascadePrivacy(
  d1: D1Database,
  appId: string,
  orgId: string,
  suffix: string,
): Promise<{ entityHash: string; privacyRequestId: string }> {
  const repo = createRepository(d1);
  await repo.privacy.entityDeletions.insert(appScope(appId), {
    appId,
    idType: "user",
    targetingKeyHash: `hash_cascade_${suffix}`,
    deleteBeforeTs: NOW_ISO,
    requestedAt: NOW_ISO,
  });
  await d1
    .prepare(
      `INSERT INTO privacy_requests (
         request_id, org_id, app_id, request_type, subject_type, subject_ref,
         requested_by, status, received_at, ack_due_at, response_due_at
       ) VALUES (?, ?, ?, 'delete', 'user', ?, ?, 'received', ?, ?, ?)`,
    )
    .bind(
      `prv_cascade_${suffix}`,
      orgId,
      appId,
      `subject_cascade_${suffix}`,
      OWNER,
      NOW_ISO,
      NOW_ISO,
      NOW_ISO,
    )
    .run();
  return {
    entityHash: `hash_cascade_${suffix}`,
    privacyRequestId: `prv_cascade_${suffix}`,
  };
}

export async function makeCascadeHarness(): Promise<CascadeHarness> {
  const bindings = await makeLocalBindings();
  const signer = await makeFixtureSigner();
  const verifier = makeJwksVerifier({
    issuer: "https://auth.splitch.test",
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  const app = createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier,
      sessions: makeSessionStore(bindings.kv),
      membershipAccess: {
        authorize: async () => true,
        resolve: async () => {
          throw new Error("test fixture has no wide membership resolver");
        },
      },
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
    membershipCache: makeMembershipCacheInvalidator(bindings.kv),
    credentialStore: bindings.credentialKv,
    exposureStatusCleanup: noOpExposureStatusCleanup,
    holdoverWriteOutboxCleanup: noOpHoldoverWriteOutboxCleanup,
    nowIso: () => NOW_ISO,
  });

  return {
    app,
    signer,
    bindings,
    async appToken(appId, userId = OWNER) {
      return signer.sign({
        sub: userId,
        iss: "https://auth.splitch.test",
        aud: AUDIENCE,
        iat: nowSeconds(),
        exp: nowSeconds() + 3600,
        scopes: [`app:${appId}:owner`],
      });
    },
    async createDefaultApp(suffix) {
      const jwt = await signer.sign({
        sub: OWNER,
        iss: "https://auth.splitch.test",
        aud: AUDIENCE,
        iat: nowSeconds(),
        exp: nowSeconds() + 3600,
        scopes: [`org:${ORG.orgId}:owner`],
      });
      const res = await app.request(`/orgs/${ORG.orgId}/apps`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "idempotency-key": `create_${suffix}`,
        },
        body: JSON.stringify({ name: `Cascade ${suffix}`, key: `cascade-${suffix}` }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        app: { id: string };
        environments: Array<{ id: string; key: string }>;
      };
    },
    seedChildren: (appId, environmentId, suffix) =>
      seedCascadeChildren(bindings.d1, appId, environmentId, suffix),
    seedPrivacyLedger: (appId, orgId, suffix) =>
      seedCascadePrivacy(bindings.d1, appId, orgId, suffix),
    async privacyCounts(appId, orgId) {
      const entities = await bindings.d1
        .prepare("SELECT COUNT(*) AS n FROM entity_deletions WHERE app_id = ?")
        .bind(appId)
        .first<{ n: number }>();
      const requests = await bindings.d1
        .prepare("SELECT COUNT(*) AS n FROM privacy_requests WHERE org_id = ? AND app_id = ?")
        .bind(orgId, appId)
        .first<{ n: number }>();
      return { entities: entities?.n ?? 0, requests: requests?.n ?? 0 };
    },
  };
}
