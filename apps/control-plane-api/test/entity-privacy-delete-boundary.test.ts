import { appScope, createRepository } from "@splitch/db";
import { computeTargetingKeyHash } from "@splitch/privacy";
import type { RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeEnvSaltStore } from "../src/local-salt-store";
import { appAdminScope } from "../src/scope-binding";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp } from "../src/test-seeds";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 18, 12, 0, 0);
const NOW_ISO = "2026-07-18T12:00:00.000Z";
const PRIMARY = {
  orgId: "org_entity_privacy_holdover",
  orgName: "Entity Privacy Holdover",
  appId: "app_entity_privacy_holdover",
  appName: "Primary",
  appKey: "entity-privacy-holdover",
};
const APP_ADMIN = "user_entity_privacy_admin";
const allowLimiter: RateLimiter = () => ({ limited: false });

describe("entity privacy delete → holdover outbox boundary", () => {
  let bindings: LocalBindings;
  let signer: FixtureSigner;

  beforeAll(async () => {
    const seeded = await makeLocalBindings();
    await seedOrgApp(seeded.d1, PRIMARY);
    await seeded.d1
      .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(PRIMARY.appId, APP_ADMIN, "admin", NOW_ISO)
      .run();
  });

  beforeEach(async () => {
    bindings = await makeLocalBindings();
    signer = await makeFixtureSigner();
  });

  afterEach(async () => bindings.dispose());

  it("inserts entity_deletions then awaits holdover cleanup with hashed identity and cutoff", async () => {
    const deletes: unknown[] = [];
    const saltStore = makeEnvSaltStore({ SPLITCH_PLATFORM_TARGET: "local" });
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          fetchJwks: async () => signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
        sessions: makeSessionStore(bindings.kv),
        now: () => NOW_MS,
      }),
      rateLimiter: allowLimiter,
      repo: createRepository(bindings.d1),
      saltStore,
      nowIso: () => NOW_ISO,
      holdoverWriteOutboxCleanup: {
        async delete(input) {
          deletes.push(input);
        },
      },
    });

    const jwt = await signer.sign({
      sub: APP_ADMIN,
      iss: "https://auth.splitch.test",
      aud: AUDIENCE,
      iat: Math.floor(NOW_MS / 1000),
      exp: Math.floor(NOW_MS / 1000) + 3600,
      scopes: [appAdminScope(PRIMARY.appId)],
    });
    const targetingKey = "subject_entity_privacy";
    const response = await app.request(`/apps/${PRIMARY.appId}/privacy/entities/delete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idType: "user", targetingKey }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      request: { status: string; subjectType: string };
      job: { kind: string; status: string };
    };
    expect(body.request).toMatchObject({ status: "processing", subjectType: "entity" });
    expect(body.job).toMatchObject({ kind: "delete", status: "queued" });

    const targetingKeyHash = await computeTargetingKeyHash(saltStore, {
      appId: PRIMARY.appId,
      idType: "user",
      targetingKey,
    });
    expect(deletes).toEqual([
      {
        appId: PRIMARY.appId,
        idType: "user",
        targetingKeyHash,
        deleteBeforeTs: NOW_ISO,
        actorId: APP_ADMIN,
        orgId: PRIMARY.orgId,
        requestId: expect.any(String),
      },
    ]);
    expect(JSON.stringify(deletes)).not.toContain(targetingKey);

    const tombstones = await createRepository(bindings.d1).privacy.listEntityDeletions(
      appScope(PRIMARY.appId),
    );
    expect(tombstones).toEqual([
      expect.objectContaining({
        appId: PRIMARY.appId,
        idType: "user",
        targetingKeyHash,
        deleteBeforeTs: NOW_ISO,
      }),
    ]);
  });
});
