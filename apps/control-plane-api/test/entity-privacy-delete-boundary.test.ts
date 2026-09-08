import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import type { EntityPrivacyLedgerInput } from "../src/config-store-app-identity-ledger";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { appAdminScope } from "../src/scope-binding";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

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
const RAW_TARGETING_KEY = "subject_entity_privacy";
const allowLimiter: RateLimiter = () => ({ limited: false });

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: One pooled Worker fixture proves the complete intake and tenant boundary.
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

  afterEach(async () => {
    vi.restoreAllMocks();
    await bindings.dispose();
  });

  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: One request chain proves persistence, replay, export intake, and authorization together.
  it("records and queues an idempotent delete before destructive effects", async () => {
    const hashes = ["local-v1:abc", "app-v1:def"] as const;
    const repo = createRepository(bindings.d1);
    const operations: string[] = [];
    const queued: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
      repo,
      configStore: identityCoordinator(repo, operations),
      nowIso: () => NOW_ISO,
      entityPrivacy: {
        async resolveIdentity() {
          operations.push("identity");
          const assignmentRecords = [
            {
              targetingKeyHash: hashes[0],
              assignments: { "exp-old": { runId: "run-old", variant: "control" } },
              assignmentWriterAssignments: {
                "exp-old": { runId: "run-old", variant: "control" },
              },
              holdoverWrites: [{ environmentId: "env-prod", experimentId: "exp-old" }],
            },
          ];
          return {
            appId: PRIMARY.appId,
            idType: "user",
            targetingKeyHashes: hashes,
            entityFamilyHash: hashes[0],
            records: assignmentRecords,
            exportArtifact: {
              schemaVersion: "entity-privacy-export-v1",
              appId: PRIMARY.appId,
              idType: "user",
              targetingKeyHashes: hashes,
              entityFamilyHash: hashes[0],
              stores: [
                {
                  name: "assignments",
                  records: assignmentRecords,
                  proofs: hashes.map((hash) => `assignment-kv:${hash}`),
                },
                {
                  name: "analysis",
                  records: [{ source: "metric_events", event_name: "purchase" }],
                  proofs: hashes.map((hash) => `tinybird:metric_events:${hash}`),
                },
                {
                  name: "event-ingest",
                  records: [{ store: "metric-event-outbox", deliveryId: "delivery-1" }],
                  proofs: hashes.map((hash) => `metric-event-outbox-inventory:${hash}`),
                },
              ],
            },
          };
        },
        async exportAssignmentsPage() {
          throw new Error("not used");
        },
        async exportAnalysisPage() {
          throw new Error("not used");
        },
        async exportEventsPage() {
          throw new Error("not used");
        },
        async exportEntity() {
          throw new Error("not used");
        },
        async suppressAnalysis() {
          operations.push("analysis-suppression");
          return identityResult();
        },
        async suppressEvents() {
          operations.push("event-ingest-suppression");
          return identityResult();
        },
        async deleteAssignments() {
          operations.push("assignments");
          return deletedResult();
        },
        async deleteAnalysis() {
          operations.push("analysis");
          return identityResult();
        },
        async deleteEvents() {
          operations.push("event-ingest");
          return identityResult();
        },
      },
      privacyJobs: {
        send: async (message: unknown) => {
          operations.push("queue");
          queued.push(message);
        },
      } as unknown as Queue<{ requestId: string }>,
    });

    function identityResult() {
      return {
        appId: PRIMARY.appId,
        idType: "user",
        targetingKeyHashes: hashes,
        entityFamilyHash: hashes[0],
        proofs: ["proof"],
      };
    }

    function deletedResult() {
      return {
        ...identityResult(),
        deletedKeyCount: hashes.length,
        deletedWriterCount: hashes.length,
        deletedOutboxCount: hashes.length,
      };
    }

    const jwt = await signer.sign({
      sub: APP_ADMIN,
      iss: "https://auth.splitch.test",
      aud: AUDIENCE,
      iat: Math.floor(NOW_MS / 1000),
      exp: Math.floor(NOW_MS / 1000) + 3600,
      scopes: [appAdminScope(PRIMARY.appId)],
    });
    const deleteRequest = () =>
      app.request(`/apps/${PRIMARY.appId}/privacy/entities/delete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "idempotency-key": "entity-delete-1",
        },
        body: JSON.stringify({ idType: "user", targetingKey: RAW_TARGETING_KEY }),
      });
    const deleted = await deleteRequest();

    expect(deleted.status).toBe(200);
    const deleteBody = await deleted.json();
    expect(deleteBody).toMatchObject({
      request: { requestType: "delete", subjectType: "entity", status: "processing" },
      job: {
        kind: "delete",
        status: "queued",
        storeStatus: {
          "analysis-suppression": "pending",
          "event-ingest-suppression": "pending",
          "d1-tombstone": "pending",
          assignments: "pending",
          analysis: "pending",
          "event-ingest": "pending",
        },
      },
    });
    expect(JSON.stringify(deleteBody)).not.toContain(RAW_TARGETING_KEY);
    expect(operations).toEqual(["identity", "intake", "queue"]);

    const replayed = await deleteRequest();
    expect(replayed.status).toBe(200);
    expect((await replayed.json()).request.requestId).toBe(deleteBody.request.requestId);
    expect(operations).toEqual(["identity", "intake", "queue", "identity", "intake", "queue"]);

    const status = await app.request(`/privacy/requests/${deleteBody.request.requestId}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ job: { status: "queued" } });

    const exported = await app.request(`/apps/${PRIMARY.appId}/privacy/entities/export`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": "entity-export-1",
      },
      body: JSON.stringify({ idType: "user", targetingKey: RAW_TARGETING_KEY }),
    });
    expect(exported.status).toBe(200);
    const exportBody = await exported.json();
    expect(exportBody).toMatchObject({
      request: { requestType: "export", status: "processing" },
      job: { kind: "export", status: "queued" },
    });
    expect(exportBody.job.downloadUrl).toBeUndefined();
    expect(JSON.stringify(exportBody)).not.toContain(RAW_TARGETING_KEY);
    const exportRequestRow = await bindings.d1
      .prepare("SELECT result_json FROM privacy_requests WHERE request_id = ?")
      .bind(exportBody.request.requestId)
      .first<{ result_json: string | null }>();
    expect(exportRequestRow?.result_json).toBeNull();
    expect(JSON.stringify(queued)).not.toContain(RAW_TARGETING_KEY);
    const storedPrivacyData = await bindings.d1
      .prepare(
        `SELECT request_id, subject_ref, request_hash, result_json FROM privacy_requests
         UNION ALL
         SELECT request_id, store_status_json, artifact_key, artifact_sha256 FROM privacy_jobs`,
      )
      .all();
    expect(JSON.stringify(storedPrivacyData.results)).not.toContain(RAW_TARGETING_KEY);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(RAW_TARGETING_KEY);

    const outsiderJwt = await signer.sign({
      sub: "user_other_tenant",
      iss: "https://auth.splitch.test",
      aud: AUDIENCE,
      iat: Math.floor(NOW_MS / 1000),
      exp: Math.floor(NOW_MS / 1000) + 3600,
      scopes: [appAdminScope(PRIMARY.appId)],
    });
    const forbidden = await app.request(`/privacy/requests/${deleteBody.request.requestId}`, {
      headers: { authorization: `Bearer ${outsiderJwt}` },
    });
    expect(forbidden.status).toBe(403);
  });
});

function identityCoordinator(repo: ReturnType<typeof createRepository>, operations: string[]) {
  return {
    writerFor: () => {
      throw new Error("not used");
    },
    liveUpdatesFor: () => {
      throw new Error("not used");
    },
    beginEntityPrivacy: async () => "app-v1",
    recordEntityDeletionSuppression: async () => {
      operations.push("d1-tombstone");
    },
    recordEntityPrivacyRequest: async (
      _appId: string,
      _version: string,
      input: EntityPrivacyLedgerInput,
    ) => {
      operations.push("intake");
      return repo.privacy.beginEntityPrivacyJob(input);
    },
  };
}
