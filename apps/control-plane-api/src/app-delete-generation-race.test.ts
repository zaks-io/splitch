import { createRepository } from "@splitch/db";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import type { HoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";

const APP_ID = "app_generation_race";
const ORG_ID = "org_generation_race";
const GENERATION_A = "00000000-0000-4000-8000-00000000000a";
const GENERATION_B = "00000000-0000-4000-8000-00000000000b";
const SHARED_REQUEST_ID = "shared-request-id";

let bindings: LocalBindings;

beforeEach(async () => {
  bindings = await makeLocalBindings();
  await bindings.d1.batch([
    bindings.d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(ORG_ID, "Generation Org", "generation-org", "2026-08-19", "2026-08-19"),
    bindings.d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(APP_ID, ORG_ID, "Generation App", "generation-app", "2026-08-19", "2026-08-19"),
    bindings.d1
      .prepare(
        "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(APP_ID, "user_owner", "owner", "2026-08-19"),
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await bindings.dispose();
});

describe("App delete shared-generation recovery", () => {
  it("cancels Evaluation suppression when a shared saga disappears before the D1 boundary", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(GENERATION_A)
      .mockReturnValueOnce(GENERATION_B);
    const realRepo = createRepository(bindings.d1);
    const realCancel = realRepo.identity.cancelAppDeletionSaga;
    const realDelete = realRepo.identity.deleteAppCascade;
    const firstPrepareReached = deferred<void>();
    const secondPrepareReached = deferred<void>();
    const releaseFirstPrepare = deferred<void>();
    const firstCancelCommitted = deferred<void>();
    const releaseFirstCancelResponse = deferred<void>();
    const prepareGenerations: string[] = [];
    const cancelInputs: Array<{ generationId: string; requestId: string }> = [];
    let suppressedGeneration: string | null = null;
    let finalizeCalls = 0;
    const holdover: HoldoverWriteOutboxCleanup = {
      async prepare(input) {
        prepareGenerations.push(input.generationId);
        suppressedGeneration = input.generationId;
        if (prepareGenerations.length === 1) {
          firstPrepareReached.resolve();
          await releaseFirstPrepare.promise;
          throw new Error("forced first handler failure after prepare");
        }
        secondPrepareReached.resolve();
      },
      async markD1Deleted() {},
      async finalize() {
        finalizeCalls += 1;
      },
      async cancel(input) {
        cancelInputs.push({ generationId: input.generationId, requestId: input.requestId });
        if (suppressedGeneration === input.generationId) suppressedGeneration = null;
      },
      async delete() {},
    };
    const repo = {
      ...realRepo,
      identity: {
        ...realRepo.identity,
        async cancelAppDeletionSaga(...args: Parameters<typeof realCancel>) {
          const won = await realCancel(...args);
          firstCancelCommitted.resolve();
          await releaseFirstCancelResponse.promise;
          return won;
        },
        async deleteAppCascade(...args: Parameters<typeof realDelete>) {
          await firstCancelCommitted.promise;
          return realDelete(...args);
        },
      },
    };
    const app = createTestApp(holdover, repo);

    const first = deleteRequest(app, "request-A");
    await firstPrepareReached.promise;
    const second = deleteRequest(app, "request-B");
    await secondPrepareReached.promise;
    releaseFirstPrepare.resolve();

    const secondResponse = await second;
    releaseFirstCancelResponse.resolve();
    const firstResponse = await first;

    expect(secondResponse.status).toBe(500);
    expect(firstResponse.status).toBe(500);
    expect(prepareGenerations).toEqual([GENERATION_A, GENERATION_A]);
    expect(cancelInputs).toEqual([
      { generationId: GENERATION_A, requestId: "request-B" },
      { generationId: GENERATION_A, requestId: "request-A" },
    ]);
    expect(suppressedGeneration).toBeNull();
    expect(finalizeCalls).toBe(0);
    expect(await realRepo.identity.getApp(APP_ID)).not.toBeNull();
    expect(await realRepo.identity.getAppDeletionSaga(APP_ID)).toBeNull();
  });
});

describe("App delete public generation races", () => {
  it("a delayed old Evaluation cancel cannot unsuppress a newer deletion generation", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(GENERATION_A)
      .mockReturnValueOnce(GENERATION_B);
    const realRepo = createRepository(bindings.d1);
    const realCancel = realRepo.identity.cancelAppDeletionSaga;
    const realDelete = realRepo.identity.deleteAppCascade;
    const firstCancelCommitted = deferred<void>();
    const secondPrepared = deferred<void>();
    const releaseFirstCancel = deferred<void>();
    const firstCancelFinished = deferred<void>();
    const releaseSecondPrepare = deferred<void>();
    let deleteCalls = 0;
    let activeGeneration: string | null = null;
    let suppressed = false;
    const prepareGenerations: string[] = [];
    const holdover: HoldoverWriteOutboxCleanup = {
      async prepare(input) {
        prepareGenerations.push(input.generationId);
        activeGeneration = input.generationId;
        suppressed = true;
        if (input.generationId === GENERATION_B) {
          secondPrepared.resolve();
          await releaseSecondPrepare.promise;
        }
      },
      async markD1Deleted() {},
      async finalize() {},
      async cancel(input) {
        await releaseFirstCancel.promise;
        if (activeGeneration === input.generationId) suppressed = false;
        firstCancelFinished.resolve();
      },
      async delete() {},
    };
    const repo = {
      ...realRepo,
      identity: {
        ...realRepo.identity,
        async cancelAppDeletionSaga(...args: Parameters<typeof realCancel>) {
          const won = await realCancel(...args);
          if (won) firstCancelCommitted.resolve();
          return won;
        },
        async deleteAppCascade(...args: Parameters<typeof realDelete>) {
          deleteCalls += 1;
          if (deleteCalls === 1) throw new Error("forced first D1 boundary failure");
          return realDelete(...args);
        },
      },
    };
    const app = createTestApp(holdover, repo);

    const first = deleteRequest(app, SHARED_REQUEST_ID);
    await firstCancelCommitted.promise;
    const second = deleteRequest(app, SHARED_REQUEST_ID);
    await secondPrepared.promise;
    releaseFirstCancel.resolve();
    await firstCancelFinished.promise;
    expect(activeGeneration).toBe(GENERATION_B);
    expect(suppressed).toBe(true);
    releaseSecondPrepare.resolve();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(500);
    expect(secondResponse.status).toBe(200);
    expect(prepareGenerations).toEqual([GENERATION_A, GENERATION_B]);
    expect(prepareGenerations).not.toContain(SHARED_REQUEST_ID);
    expect(suppressed).toBe(true);
    expect(await realRepo.identity.getApp(APP_ID)).toBeNull();
    expect(await realRepo.identity.getAppDeletionSaga(APP_ID)).toMatchObject({
      generationId: GENERATION_B,
      phase: "complete",
    });
  });
});

function createTestApp(
  holdover: HoldoverWriteOutboxCleanup,
  repo: ReturnType<typeof createRepository>,
) {
  const authResolver: AuthResolver = makeControlPlaneAuthResolver({
    verifier: {
      async verify() {
        return {
          sub: "user_owner",
          scopes: [`app:${APP_ID}:owner`],
          authDoor: "device_flow",
        };
      },
    },
    sessions: {
      async isRevoked() {
        return false;
      },
    },
    membershipAccess: {
      authorize: async () => true,
      resolve: async () => {
        throw new Error("test fixture has no wide membership resolver");
      },
    },
  });
  const rateLimiter: RateLimiter = () => ({ limited: false });
  return createApp({
    authResolver,
    rateLimiter,
    repo,
    credentialStore: bindings.credentialKv,
    exposureStatusCleanup: { async delete() {} },
    holdoverWriteOutboxCleanup: holdover,
  });
}

function deleteRequest(app: ReturnType<typeof createTestApp>, requestId: string) {
  return app.request(`/apps/${APP_ID}`, {
    method: "DELETE",
    headers: { authorization: "Bearer device-flow-token", "x-request-id": requestId },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
