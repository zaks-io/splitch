import type { ErrorResponse } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { revokeEnvironmentCredentialsForAppDelete } from "../src/app-environment-credentials";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";
import { noOpExposureStatusCleanup } from "./exposure-status-cleanup-fixture";
import { noOpHoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup-fixture";

/**
 * SPL-298: a failed `apps delete` must leave the App manageable — live
 * membership, app-scoped reads, Client Key revocation, and grant issuance all
 * keep working. Workers-pool D1 applies real migrations (FK enforcement).
 */

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 7, 4, 12, 0, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();
const ORG = {
  orgId: "org_app_delete_atomic",
  orgName: "App Delete Atomic Co",
  appId: "app_existing_delete_atomic",
  appName: "Existing Delete Atomic App",
  appKey: "existing-delete-atomic",
};
const OWNER = "user_app_delete_atomic_owner";

const allowLimiter: RateLimiter = () => ({ limited: false });
const nowSeconds = () => Math.floor(NOW_MS / 1000);

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

let h: Harness;

beforeAll(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, ORG);
  await seedOrgMember(bindings.d1, {
    orgId: ORG.orgId,
    userId: OWNER,
    role: "owner",
  });
});

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  const signer = await makeFixtureSigner();
  const verifier = makeJwksVerifier({
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  h = {
    app: createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier,
        sessions: makeSessionStore(bindings.kv),
        now: () => NOW_MS,
      }),
      rateLimiter: allowLimiter,
      repo: createRepository(bindings.d1),
      credentialStore: bindings.credentialKv,
      exposureStatusCleanup: noOpExposureStatusCleanup,
      holdoverWriteOutboxCleanup: noOpHoldoverWriteOutboxCleanup,
      nowIso: () => NOW_ISO,
    }),
    signer,
    bindings,
  };
});

afterEach(async () => h.bindings.dispose());

function orgToken(): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`org:${ORG.orgId}:owner`],
  });
}

function appToken(appId: string): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`app:${appId}:owner`],
  });
}

async function createDefaultApp(key: string) {
  const res = await h.app.request(`/orgs/${ORG.orgId}/apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${await orgToken()}`, "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: ORG.orgId,
      name: `Atomic ${key}`,
      key,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    app: { id: string };
    environments: Array<{ id: string; key: string }>;
    clientKeys: Array<{ keyId: string; environmentId: string; keyMaterial: string }>;
  };
}

async function seedApprovalRequest(appId: string, suffix: string) {
  const created = await createRepository(h.bindings.d1).approvals.createRequest(appScope(appId), {
    id: `apr_delete_atomic_${suffix}`,
    operation: "update_flag_config",
    targetType: "flag_config",
    targetId: `cfg_delete_atomic_${suffix}`,
    targetVersion: "1",
    policyContexts: "[]",
    diff: "{}",
    status: "pending",
    proposedBy: OWNER,
    proposedVia: "id_jag",
    proposedAt: NOW_ISO,
    resolvedAt: null,
    resultingTargetVersion: null,
    resultingResourceType: null,
    resultingResourceId: null,
    idempotencyKey: `idem_delete_atomic_${suffix}`,
    requestHash: `hash_delete_atomic_${suffix}`,
  });
  expect(created.ok).toBe(true);
}

async function seedFlag(appId: string, suffix: string) {
  await h.bindings.d1
    .prepare(
      `INSERT INTO flags (id, app_id, key, name, schema, default_variant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', NULL, ?, ?)`,
    )
    .bind(
      `flag_delete_atomic_${suffix}`,
      appId,
      `flag-${suffix}`,
      `Flag ${suffix}`,
      NOW_ISO,
      NOW_ISO,
    )
    .run();
}

describe("apps delete atomicity and emptiness guards (SPL-298)", () => {
  it("returns RESOURCE_NOT_EMPTY for Flags and leaves app-scoped access intact", async () => {
    const created = await createDefaultApp("flag-child");
    const jwt = await appToken(created.app.id);
    await seedFlag(created.app.id, "guard");
    const repo = createRepository(h.bindings.d1);
    const keysBefore = await Promise.all(
      created.environments.map((env) =>
        repo.credentials.listClientKeys(envScope(created.app.id, env.id)),
      ),
    );

    const del = await h.app.request(`/apps/${created.app.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(del.status).toBe(409);
    expect((await del.json()) as ErrorResponse).toMatchObject({
      code: "RESOURCE_NOT_EMPTY",
      details: { childType: "flags", attemptedOp: "DELETE_APP" },
    });

    const read = await h.app.request(`/apps/${created.app.id}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: created.app.id });

    expect(await repo.identity.getAppMembership(appScope(created.app.id), OWNER)).toMatchObject({
      role: "owner",
    });
    expect(await repo.identity.listEnvironments(appScope(created.app.id))).toHaveLength(2);
    for (const [index, env] of created.environments.entries()) {
      expect(await repo.credentials.listClientKeys(envScope(created.app.id, env.id))).toEqual(
        keysBefore[index],
      );
    }

    const clientKey = created.clientKeys[0];
    expect(clientKey).toBeDefined();
    const rotate = await h.app.request(
      `/apps/${created.app.id}/envs/${clientKey?.environmentId}/client-key/revoke`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
      },
    );
    expect(rotate.status).toBe(200);
    expect(await rotate.json()).toMatchObject({
      revokedKeyId: clientKey?.keyId,
      newKey: { keyId: expect.any(String), keyMaterial: expect.any(String) },
    });
  });

  it("deletes an App that still has Approval history without stranding membership", async () => {
    const created = await createDefaultApp("approval-cascade");
    const jwt = await appToken(created.app.id);
    await seedApprovalRequest(created.app.id, "cascade");

    const del = await h.app.request(`/apps/${created.app.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });

    const read = await h.app.request(`/apps/${created.app.id}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(read.status).toBe(404);

    const repo = createRepository(h.bindings.d1);
    expect(await repo.identity.getAppMembership(appScope(created.app.id), OWNER)).toBeNull();
    expect(
      await h.bindings.d1
        .prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE app_id = ?")
        .bind(created.app.id)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 0 });
  });

  it("keeps Client Key rows after revoke+tombstone when cascade hits a late Flag FK", async () => {
    const created = await createDefaultApp("cascade-race");
    const jwt = await appToken(created.app.id);
    const repo = createRepository(h.bindings.d1);

    // Handler path past the emptiness guard: revoke/tombstone, then cascade.
    // A Flag FK (skipped by the guard) must roll back without removing keys.
    await seedFlag(created.app.id, "race");
    for (const env of created.environments) {
      await revokeEnvironmentCredentialsForAppDelete(
        { repo, credentialStore: h.bindings.credentialKv, nowIso: () => NOW_ISO },
        created.app.id,
        env.id,
      );
    }
    await expect(repo.identity.deleteAppCascade(appScope(created.app.id))).rejects.toThrow(
      /FOREIGN KEY constraint failed|app delete did not reach D1/,
    );

    expect(await repo.identity.getAppMembership(appScope(created.app.id), OWNER)).toMatchObject({
      role: "owner",
    });
    expect(await repo.identity.listEnvironments(appScope(created.app.id))).toHaveLength(2);
    for (const env of created.environments) {
      const keys = await repo.credentials.listClientKeys(envScope(created.app.id, env.id));
      expect(keys).toHaveLength(1);
      expect(keys[0]?.revokedAt).toBe(NOW_ISO);
    }

    const clientKey = created.clientKeys[0];
    expect(clientKey).toBeDefined();
    const rotate = await h.app.request(
      `/apps/${created.app.id}/envs/${clientKey?.environmentId}/client-key/revoke`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
      },
    );
    expect(rotate.status).toBe(200);
    // After the failed delete, keys remain in D1 (revoked). Rotate may mint a
    // fresh active key first, then revoke it — either way revocation stays
    // reachable on the surviving App.
    expect(await rotate.json()).toMatchObject({
      revokedKeyId: expect.any(String),
      newKey: { keyId: expect.any(String), keyMaterial: expect.any(String) },
    });

    const read = await h.app.request(`/apps/${created.app.id}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(read.status).toBe(200);
  });
});
