import { getRoute } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  orgId: "org_entity_privacy_export_intake",
  orgName: "Entity Privacy Export Intake",
  appId: "app_entity_privacy_export_intake",
  appName: "Export Intake",
  appKey: "entity-privacy-export-intake",
};
const APP_ADMIN = "user_entity_privacy_export_admin";
const RAW_TARGETING_KEY = "subject_entity_privacy_export";
const allowLimiter: RateLimiter = () => ({ limited: false });

describe("entity privacy export intake", () => {
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
    await bindings.dispose();
  });

  it("records a Privacy Request and Job then publishes the export queue message", async () => {
    expect(getRoute("entity_privacy_export")?.effects).toMatchObject({
      mutates: true,
      destructive: false,
      idempotent: true,
    });

    const hashes = ["local-v1:export-abc"] as const;
    const repo = createRepository(bindings.d1);
    const operations: string[] = [];
    const queued: unknown[] = [];
    const app = createExportIntakeApp({ bindings, signer, repo, operations, queued, hashes });

    const jwt = await signer.sign({
      sub: APP_ADMIN,
      iss: "https://auth.splitch.test",
      aud: AUDIENCE,
      iat: Math.floor(NOW_MS / 1000),
      exp: Math.floor(NOW_MS / 1000) + 3600,
      scopes: [appAdminScope(PRIMARY.appId)],
    });

    const exported = await app.request(`/apps/${PRIMARY.appId}/privacy/entities/export`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": "entity-export-intake-1",
      },
      body: JSON.stringify({ idType: "user", targetingKey: RAW_TARGETING_KEY }),
    });
    expect(exported.status).toBe(200);
    const exportBody = (await exported.json()) as {
      request: { requestId: string; requestType: string; status: string };
      job: { jobId: string; kind: string; status: string };
    };
    expect(exportBody).toMatchObject({
      request: { requestType: "export", status: "processing" },
      job: { kind: "export", status: "queued" },
    });
    expect(operations).toEqual(["identity", "intake", "queue"]);
    expect(queued).toEqual([{ requestId: exportBody.request.requestId }]);
    await expectPersistedExport(bindings, exportBody);
  });
});

async function expectPersistedExport(
  bindings: LocalBindings,
  exportBody: {
    request: { requestId: string };
    job: { jobId: string };
  },
): Promise<void> {
  const requestRow = await bindings.d1
    .prepare("SELECT request_id, request_type, status FROM privacy_requests WHERE request_id = ?")
    .bind(exportBody.request.requestId)
    .first<{ request_id: string; request_type: string; status: string }>();
  expect(requestRow).toEqual({
    request_id: exportBody.request.requestId,
    request_type: "export",
    status: "processing",
  });

  const jobRow = await bindings.d1
    .prepare("SELECT job_id, kind, status FROM privacy_jobs WHERE request_id = ?")
    .bind(exportBody.request.requestId)
    .first<{ job_id: string; kind: string; status: string }>();
  expect(jobRow).toEqual({
    job_id: exportBody.job.jobId,
    kind: "export",
    status: "queued",
  });
}

function createExportIntakeApp(args: {
  bindings: LocalBindings;
  signer: FixtureSigner;
  repo: ReturnType<typeof createRepository>;
  operations: string[];
  queued: unknown[];
  hashes: readonly [string];
}) {
  const { bindings, signer, repo, operations, queued, hashes } = args;
  return createApp({
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
    configStore: {
      writerFor: () => {
        throw new Error("not used");
      },
      liveUpdatesFor: () => {
        throw new Error("not used");
      },
      beginEntityPrivacy: async () => "app-v1",
      recordEntityDeletionSuppression: async () => undefined,
      recordEntityPrivacyRequest: async (
        _appId: string,
        _version: string,
        input: EntityPrivacyLedgerInput,
      ) => {
        operations.push("intake");
        return repo.privacy.beginEntityPrivacyJob(input);
      },
    },
    nowIso: () => NOW_ISO,
    entityPrivacy: unusedEntityPrivacy(operations, hashes),
    privacyJobs: {
      send: async (message: unknown) => {
        operations.push("queue");
        queued.push(message);
      },
    } as unknown as Queue<{ requestId: string }>,
  });
}

function unusedEntityPrivacy(operations: string[], hashes: readonly [string]) {
  return {
    async resolveIdentity() {
      operations.push("identity");
      return {
        appId: PRIMARY.appId,
        idType: "user",
        targetingKeyHashes: hashes,
        entityFamilyHash: hashes[0],
        records: [],
        exportArtifact: {
          schemaVersion: "entity-privacy-export-v1",
          appId: PRIMARY.appId,
          idType: "user",
          targetingKeyHashes: hashes,
          entityFamilyHash: hashes[0],
          stores: [],
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
      throw new Error("not used");
    },
    async suppressEvents() {
      throw new Error("not used");
    },
    async deleteAssignments() {
      throw new Error("not used");
    },
    async deleteAnalysis() {
      throw new Error("not used");
    },
    async deleteEvents() {
      throw new Error("not used");
    },
  };
}
