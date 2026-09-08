import { createRepository } from "@splitch/db";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { purgeExpiredPrivacyArtifacts, reconcilePrivacyJobs } from "../src/entity-privacy-jobs";
import type { ControlPlaneApiEnv } from "../src/env";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp } from "../src/test-seeds";
import { makePoolBindings } from "./pool-bindings";

const receivedAt = "2026-07-18T12:00:00.000Z";
const target = {
  orgId: "org_privacy_reconcile",
  orgName: "Privacy Reconcile",
  appId: "app_privacy_reconcile",
  appName: "Privacy Reconcile",
  appKey: "privacy-reconcile",
};

describe("privacy job reconciliation", () => {
  let bindings: LocalBindings;

  beforeAll(async () => {
    const seeded = await makePoolBindings();
    await seedOrgApp(seeded.d1, target);
  });

  beforeEach(async () => {
    bindings = await makePoolBindings();
  });

  afterEach(async () => bindings.dispose());

  it("re-enqueues stale durable work using only the request ID", async () => {
    const repo = createRepository(bindings.d1);
    await beginExport(repo);
    const messages: unknown[] = [];
    const count = await reconcilePrivacyJobs(
      environment(bindings, {
        send: async (message: unknown) => {
          messages.push(message);
        },
      }),
      new Date("2026-07-18T12:02:00.000Z"),
    );

    expect(count).toBe(1);
    expect(messages).toEqual([{ requestId: "prv_reconcile" }]);
    expect(JSON.stringify(messages)).not.toContain("raw-targeting-key");
  });

  it("deletes expired R2 artifacts and clears only artifact metadata", async () => {
    const repo = createRepository(bindings.d1);
    await beginExport(repo);
    const claimToken = "claim-reconcile";
    await repo.privacy.claimPrivacyJob(
      "prv_reconcile",
      "2026-07-18T12:00:30.000Z",
      "2026-07-18T12:15:30.000Z",
      claimToken,
    );
    await repo.privacy.completePrivacyExport({
      requestId: "prv_reconcile",
      storeStatusJson: JSON.stringify({ assignments: "done" }),
      artifactKey: "privacy-exports/app_privacy_reconcile/prv_reconcile.json",
      artifactSha256: `sha256:${"a".repeat(64)}`,
      artifactExpiresAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-18T12:01:00.000Z",
      claimToken,
    });
    const deleted: string[] = [];
    const env = environment(bindings, { send: async () => undefined });
    env.PRIVACY_EXPORTS = {
      delete: async (key: string | string[]) => {
        deleted.push(...(Array.isArray(key) ? key : [key]));
      },
    } as R2Bucket;

    expect(await purgeExpiredPrivacyArtifacts(env, new Date("2026-07-19T12:00:01.000Z"))).toBe(1);
    expect(deleted).toEqual(["privacy-exports/app_privacy_reconcile/prv_reconcile.json"]);
    expect(await repo.privacy.getPrivacyJobByRequestId("prv_reconcile")).toMatchObject({
      status: "completed",
      artifactKey: null,
      artifactSha256: null,
      artifactExpiresAt: null,
    });
  });

  it("fences stale workers from a replacement claim", async () => {
    const repo = createRepository(bindings.d1);
    const requestId = "prv_reconcile_fence";
    await beginExport(repo, requestId);
    await repo.privacy.claimPrivacyJob(
      requestId,
      "2026-07-18T12:00:00.000Z",
      "2026-07-18T12:01:00.000Z",
      "claim-stale",
    );
    await repo.privacy.claimPrivacyJob(
      requestId,
      "2026-07-18T12:02:00.000Z",
      "2026-07-18T12:17:00.000Z",
      "claim-current",
    );

    await expect(
      repo.privacy.updatePrivacyJob({
        requestId,
        status: "failed",
        storeStatusJson: JSON.stringify({ assignments: "failed" }),
        updatedAt: "2026-07-18T12:02:01.000Z",
        errorCode: "STALE_WORKER",
        claimToken: "claim-stale",
      }),
    ).rejects.toThrow();
    expect(await repo.privacy.getPrivacyJobByRequestId(requestId)).toMatchObject({
      status: "running",
      claimToken: "claim-current",
      errorCode: null,
    });
  });
});

async function beginExport(repo: ReturnType<typeof createRepository>, requestId = "prv_reconcile") {
  return repo.privacy.beginEntityPrivacyJob({
    requestId,
    jobId: `job_${requestId}`,
    orgId: target.orgId,
    appId: target.appId,
    requestType: "export",
    subjectRef: JSON.stringify(["app-v1:subject"]),
    requestedBy: "user_admin",
    receivedAt,
    ackDueAt: "2026-07-28T12:00:00.000Z",
    responseDueAt: "2026-09-01T12:00:00.000Z",
    idempotencyKey: `reconcile-${requestId}`,
    requestHash: `sha256:${"b".repeat(64)}`,
    storeStatusJson: JSON.stringify({ assignments: "pending" }),
    deleteBeforeTs: null,
    identityVersion: "app-v1",
    idType: "user",
    entityFamilyHash: "app-v1:subject",
  });
}

function environment(
  bindings: LocalBindings,
  queue: { send(message: unknown): Promise<void> },
): ControlPlaneApiEnv {
  return {
    DB: bindings.d1,
    PRIVACY_JOBS_QUEUE: queue as Queue<{ requestId: string }>,
    PRIVACY_EXPORTS: {} as R2Bucket,
  } as ControlPlaneApiEnv;
}
