import { type ErrorResponse } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { appAdminScope } from "../src/scope-binding";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedAppMember, seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 18, 12, 0, 0);
const APP = {
  orgId: "org_privacy_status_authorization",
  orgName: "Privacy Status Authorization",
  appId: "app_privacy_status_authorization",
  appName: "Privacy Status Authorization",
  appKey: "privacy-status-authorization",
};
const OWNER = "user_privacy_status_owner";
const ADMIN = "user_privacy_status_admin";
const REQUESTER = "user_privacy_status_requester";
const OUTSIDER = "user_privacy_status_outsider";
const APP_REQUEST_ID = "privacy_status_app_request";
const USER_REQUEST_ID = "privacy_status_user_request";
const allowLimiter: RateLimiter = () => ({ limited: false });

interface Harness {
  app: Hono;
  bindings: LocalBindings;
  signer: FixtureSigner;
}

let h: Harness;

beforeAll(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, APP);
  await seedOrgMember(bindings.d1, { orgId: APP.orgId, userId: OWNER, role: "owner" });
  await seedAppMember(bindings.d1, {
    appId: APP.appId,
    userId: ADMIN,
    role: "admin",
    createdAt: "2026-07-18T12:00:00.000Z",
  });
  await seedPrivacyRequest(bindings, {
    requestId: APP_REQUEST_ID,
    appId: APP.appId,
    subjectType: "app",
    subjectRef: APP.appId,
    requestedBy: REQUESTER,
    status: "completed",
  });
  await seedCompletedPrivacyExport(bindings);
  await seedPrivacyRequest(bindings, {
    requestId: USER_REQUEST_ID,
    appId: null,
    subjectType: "user",
    subjectRef: REQUESTER,
    requestedBy: REQUESTER,
    status: "received",
  });
});

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  const signer = await makeFixtureSigner();
  h = {
    app: createApp({
      door: "binding",
      apiVersion: () => "local",
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
      convex: {},
      cloudflare: {},
      sentry: {},
      privacyExportUrlSecret: "privacy-status-authorization-secret",
      nowIso: () => new Date(NOW_MS).toISOString(),
    }),
    bindings,
    signer,
  };
});

afterEach(async () => h.bindings.dispose());

describe("privacy request status authorization", () => {
  it("requires current tenant authority for tenant privacy request status", async () => {
    for (const jwt of [
      await token([`org:${APP.orgId}:owner`], OWNER),
      await token([appAdminScope(APP.appId)], ADMIN),
    ]) {
      const response = await request(APP_REQUEST_ID, jwt);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        request: { status: string };
        job: { downloadUrl?: string; status: string };
      };
      expect(body.request.status).toBe("completed");
      expect(body.job.status).toBe("completed");
      expect(body.job.downloadUrl).toContain(`/privacy/requests/${APP_REQUEST_ID}/download?`);
    }

    for (const jwt of [
      await token([], REQUESTER),
      await token([], OUTSIDER),
      await token([], OWNER),
      await token([], ADMIN),
    ]) {
      const response = await request(APP_REQUEST_ID, jwt);
      expect(response.status).toBe(403);
      const body = (await response.json()) as ErrorResponse;
      expect(body.code).toBe("FORBIDDEN");
      expect(body).not.toHaveProperty("downloadUrl");
    }
  });

  it("lets a requester read their own User privacy request", async () => {
    const response = await request(USER_REQUEST_ID, await token([], REQUESTER));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request: { requestId: USER_REQUEST_ID, status: "received" },
      job: null,
    });
  });
});

function token(scopes: string[], userId: string): Promise<string> {
  const now = Math.floor(NOW_MS / 1000);
  return h.signer.sign({
    sub: userId,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: now,
    exp: now + 3600,
    scopes,
  });
}

function request(requestId: string, jwt: string) {
  return h.app.request(`/privacy/requests/${requestId}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
}

async function seedPrivacyRequest(
  bindings: LocalBindings,
  values: {
    requestId: string;
    appId: string | null;
    subjectType: "app" | "user";
    subjectRef: string;
    requestedBy: string;
    status: "received" | "completed";
  },
): Promise<void> {
  await bindings.d1
    .prepare(
      "INSERT INTO privacy_requests (request_id, org_id, app_id, request_type, subject_type, subject_ref, requested_by, status, received_at, ack_due_at, response_due_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      values.requestId,
      APP.orgId,
      values.appId,
      "export",
      values.subjectType,
      values.subjectRef,
      values.requestedBy,
      values.status,
      "2026-07-18T12:00:00.000Z",
      "2026-07-19T12:00:00.000Z",
      "2026-08-18T12:00:00.000Z",
    )
    .run();
}

async function seedCompletedPrivacyExport(bindings: LocalBindings): Promise<void> {
  await bindings.d1
    .prepare(
      "INSERT INTO privacy_jobs (job_id, request_id, kind, status, store_status_json, identity_version, artifact_key, artifact_sha256, artifact_expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      `job_${APP_REQUEST_ID}`,
      APP_REQUEST_ID,
      "export",
      "completed",
      "{}",
      "app-v1",
      `privacy-exports/${APP.appId}/${APP_REQUEST_ID}.json`,
      `sha256:${"a".repeat(64)}`,
      "2026-07-19T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
    )
    .run();
}
