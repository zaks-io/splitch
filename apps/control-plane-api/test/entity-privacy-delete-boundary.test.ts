import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
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

describe("entity privacy delete route availability", () => {
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

  it("stays fail-loud unavailable even when holdover cleanup is wired", async () => {
    const app = createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          issuer: "https://auth.splitch.test",
          fetchJwks: async () => signer.jwks,
          controlPlaneAudience: AUDIENCE,
        }),
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
      holdoverWriteOutboxCleanup: {
        async prepare() {
          throw new Error("entity privacy must not claim queued deletion");
        },
        async markD1Deleted() {
          throw new Error("entity privacy must not claim queued deletion");
        },
        async finalize() {
          throw new Error("entity privacy must not claim queued deletion");
        },
        async cancel() {
          throw new Error("entity privacy must not claim queued deletion");
        },
        async delete() {
          throw new Error("entity privacy must not claim queued deletion");
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
    const response = await app.request(`/apps/${PRIMARY.appId}/privacy/entities/delete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idType: "user", targetingKey: "subject_entity_privacy" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "operation is not available yet",
    });
  });
});
