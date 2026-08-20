import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { createRepository } from "@splitch/db";
import { afterEach, beforeEach } from "vitest";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";
import type { EnvironmentExposureStatusCleanupInput } from "./environment-exposure-status-cleanup";
import type { HoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup";
import { makeControlPlaneAuthResolver } from "./auth-resolver";

const APP_ID = "app_finalize_resume";
const ORG_ID = "org_finalize_resume";

let bindings: LocalBindings;

beforeEach(async () => {
  bindings = await makeLocalBindings();
  await bindings.d1.batch([
    bindings.d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(ORG_ID, "Resume Org", "resume-org", "2026-08-18", "2026-08-18"),
    bindings.d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(APP_ID, ORG_ID, "Resume App", "resume-app", "2026-08-18", "2026-08-18"),
    bindings.d1
      .prepare(
        "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(APP_ID, "user_owner", "owner", "2026-08-18"),
  ]);
});

afterEach(async () => bindings.dispose());

describe("App delete public finalize resume after D1 cascade", () => {
  it("DELETE retry after finalize failure completes without cancel/rollback", async () => {
    const phases: string[] = [];
    let finalizeFailsRemaining = 1;
    const holdover: HoldoverWriteOutboxCleanup = {
      async prepare() {
        phases.push("prepare");
      },
      async markD1Deleted() {
        phases.push("mark-d1-deleted");
      },
      async finalize() {
        phases.push("finalize");
        if (finalizeFailsRemaining > 0) {
          finalizeFailsRemaining -= 1;
          const { HoldoverWriteOutboxCleanupError } = await import(
            "./holdover-write-outbox-cleanup"
          );
          throw new HoldoverWriteOutboxCleanupError(
            "control-plane-api: holdover write outbox cleanup failed with HTTP 503",
          );
        }
      },
      async cancel() {
        phases.push("cancel");
      },
      async delete() {
        phases.push("delete");
      },
    };
    const exposures: EnvironmentExposureStatusCleanupInput[] = [];
    const app = createTestApp(holdover, exposures);

    const first = await deleteRequest(app);
    expect(first.status).toBe(503);
    expect(await createRepository(bindings.d1).identity.getApp(APP_ID)).toBeNull();
    expect(phases).toEqual(["prepare", "mark-d1-deleted", "finalize"]);
    expect(phases).not.toContain("cancel");

    const retry = await deleteRequest(app);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ deleted: true });
    expect(phases).toEqual([
      "prepare",
      "mark-d1-deleted",
      "finalize",
      "mark-d1-deleted",
      "finalize",
    ]);
    expect(phases.filter((phase) => phase === "cancel")).toEqual([]);
    expect(exposures).toHaveLength(1);

    const completedRetry = await deleteRequest(app);
    expect(completedRetry.status).toBe(200);
    const otherActor = createTestApp(holdover, exposures, false, undefined, {
      actorId: "user_other",
      scopes: [`app:${APP_ID}:owner`],
    });
    expect((await deleteRequest(otherActor)).status).toBe(403);
  });

  it("never cancels when the D1 commit response is lost", async () => {
    const phases: string[] = [];
    const holdover: HoldoverWriteOutboxCleanup = {
      async prepare() {
        phases.push("prepare");
      },
      async markD1Deleted() {
        phases.push("mark-d1-deleted");
      },
      async finalize() {
        phases.push("finalize");
      },
      async cancel() {
        phases.push("cancel");
      },
      async delete() {
        phases.push("delete");
      },
    };
    const exposures: EnvironmentExposureStatusCleanupInput[] = [];
    const app = createTestApp(holdover, exposures, true);

    const response = await deleteRequest(app);

    expect(response.status).toBe(200);
    expect(phases).toEqual(["prepare", "mark-d1-deleted", "finalize"]);
    expect(await createRepository(bindings.d1).identity.getApp(APP_ID)).toBeNull();
    expect(await createRepository(bindings.d1).identity.getAppDeletionSaga(APP_ID)).toMatchObject({
      phase: "complete",
    });
  });
});

describe("App delete public D1 cancellation races", () => {
  it("a D1 boundary crossing wins against a concurrent handler cancel", async () => {
    const realRepo = createRepository(bindings.d1);
    const realCancel = realRepo.identity.cancelAppDeletionSaga;
    const realDelete = realRepo.identity.deleteAppCascade;
    const boundaryCrossed = deferred<void>();
    let prepareCalls = 0;
    let evaluationCancels = 0;
    const holdover: HoldoverWriteOutboxCleanup = {
      async prepare() {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          throw new Error("forced first prepare failure");
        }
      },
      async markD1Deleted() {},
      async finalize() {},
      async cancel() {
        evaluationCancels += 1;
      },
      async delete() {},
    };
    const repo = {
      ...realRepo,
      identity: {
        ...realRepo.identity,
        async cancelAppDeletionSaga(...args: Parameters<typeof realCancel>) {
          await boundaryCrossed.promise;
          return realCancel(...args);
        },
        async deleteAppCascade(...args: Parameters<typeof realDelete>) {
          await realDelete(...args);
          boundaryCrossed.resolve();
        },
      },
    };
    const app = createTestApp(holdover, [], false, repo);

    const first = deleteRequest(app);
    await waitFor(() => prepareCalls === 1);
    const second = deleteRequest(app);
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(evaluationCancels).toBe(0);
    expect(await realRepo.identity.getApp(APP_ID)).toBeNull();
    expect(await realRepo.identity.getAppDeletionSaga(APP_ID)).toMatchObject({ phase: "complete" });
  });

  it("restores the live App when the cancel CAS response is lost after commit", async () => {
    const realRepo = createRepository(bindings.d1);
    const realCancel = realRepo.identity.cancelAppDeletionSaga;
    let cancelCommitted = false;
    let suppressed = false;
    const holdover: HoldoverWriteOutboxCleanup = {
      async prepare() {
        suppressed = true;
      },
      async markD1Deleted() {},
      async finalize() {},
      async cancel() {
        suppressed = false;
      },
      async delete() {},
    };
    const repo = {
      ...realRepo,
      identity: {
        ...realRepo.identity,
        async deleteAppCascade() {
          throw new Error("forced failure before D1 boundary");
        },
        async cancelAppDeletionSaga(...args: Parameters<typeof realCancel>) {
          cancelCommitted = await realCancel(...args);
          throw new Error("forced lost cancel CAS response");
        },
      },
    };
    const app = createTestApp(holdover, [], false, repo);

    const response = await deleteRequest(app);

    expect(response.status).toBe(500);
    expect(cancelCommitted).toBe(true);
    expect(suppressed).toBe(false);
    expect(await realRepo.identity.getApp(APP_ID)).not.toBeNull();
    expect(await realRepo.identity.getAppDeletionSaga(APP_ID)).toBeNull();
  });
});

function createTestApp(
  holdover: HoldoverWriteOutboxCleanup,
  exposures: EnvironmentExposureStatusCleanupInput[],
  loseDeleteResponse = false,
  repoOverride?: ReturnType<typeof createRepository>,
  auth: { actorId: string; scopes: string[] } = {
    actorId: "user_owner",
    scopes: [`app:${APP_ID}:owner`],
  },
) {
  const authResolver: AuthResolver = makeControlPlaneAuthResolver({
    verifier: {
      async verify() {
        return {
          sub: auth.actorId,
          scopes: auth.scopes,
          authDoor: "device_flow",
        };
      },
    },
    sessions: {
      async isRevoked() {
        return false;
      },
    },
  });
  const rateLimiter: RateLimiter = () => ({ limited: false });
  const repo = repoOverride ?? createRepository(bindings.d1);
  const deleteAppCascade = repo.identity.deleteAppCascade;
  return createApp({
    authResolver,
    rateLimiter,
    repo: loseDeleteResponse
      ? {
          ...repo,
          identity: {
            ...repo.identity,
            async deleteAppCascade(...args: Parameters<typeof deleteAppCascade>) {
              await deleteAppCascade(...args);
              throw new Error("forced lost D1 commit response");
            },
          },
        }
      : repo,
    credentialStore: bindings.credentialKv,
    exposureStatusCleanup: {
      delete: async (input) => {
        exposures.push(input);
      },
    },
    holdoverWriteOutboxCleanup: holdover,
  });
}

function deleteRequest(app: ReturnType<typeof createTestApp>) {
  return app.request(`/apps/${APP_ID}`, {
    method: "DELETE",
    headers: { authorization: "Bearer device-flow-token" },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}
