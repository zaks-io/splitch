import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";

const NOW = "2026-08-19T12:00:00.000Z";
const APP_ID = "app_deletion_boundary";
const ORG_ID = "org_deletion_boundary";
const ACTOR_ID = "user_deletion_boundary";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  await local.d1.batch([
    local.d1
      .prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at)
         VALUES (?, 'Deletion Boundary', 'deletion-boundary', ?, ?)`,
      )
      .bind(ORG_ID, NOW, NOW),
    local.d1
      .prepare(
        `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
         VALUES (?, ?, 'Deletion Boundary', 'deletion-boundary', ?, ?)`,
      )
      .bind(APP_ID, ORG_ID, NOW, NOW),
    local.d1
      .prepare(
        `INSERT INTO app_memberships (app_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .bind(APP_ID, ACTOR_ID, NOW),
  ]);
});

afterEach(async () => local.dispose());

describe("App deletion D1 boundary", () => {
  it("commits the recovery boundary atomically with deleting the App", async () => {
    const saga = await beginSaga();

    await repo.identity.deleteAppCascade(appScope(APP_ID), boundary(saga));

    expect(await repo.identity.getApp(APP_ID)).toBeNull();
    expect(await repo.identity.getAppDeletionSaga(APP_ID)).toMatchObject({
      phase: "d1_deleted",
      appId: APP_ID,
      organizationId: ORG_ID,
      actorId: ACTOR_ID,
    });
  });

  it("aborts before child deletion when the recovery record is missing", async () => {
    await expect(
      repo.identity.deleteAppCascade(appScope(APP_ID), {
        actorId: ACTOR_ID,
        organizationId: ORG_ID,
        deleteBeforeTs: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow(/malformed JSON|App deletion boundary/u);

    expect(await repo.identity.getApp(APP_ID)).not.toBeNull();
    expect(await repo.identity.getAppMembership(appScope(APP_ID), ACTOR_ID)).not.toBeNull();
  });

  it("rolls the boundary back when the App delete fails", async () => {
    const saga = await beginSaga();
    await local.d1
      .prepare(
        `CREATE TRIGGER fail_boundary_app_delete
         BEFORE DELETE ON apps WHEN OLD.id = '${APP_ID}'
         BEGIN SELECT RAISE(FAIL, 'forced App deletion failure'); END`,
      )
      .run();

    await expect(repo.identity.deleteAppCascade(appScope(APP_ID), boundary(saga))).rejects.toThrow(
      /forced App deletion failure/u,
    );

    expect(await repo.identity.getApp(APP_ID)).not.toBeNull();
    expect(await repo.identity.getAppDeletionSaga(APP_ID)).toMatchObject({ phase: "started" });
    expect(await repo.identity.getAppMembership(appScope(APP_ID), ACTOR_ID)).not.toBeNull();
    await local.d1.prepare("DROP TRIGGER fail_boundary_app_delete").run();
  });

  it("does not overwrite an active saga and makes cancel exclusive with the boundary", async () => {
    const saga = await beginSaga();
    const retry = await repo.identity.beginAppDeletionSaga({
      appId: APP_ID,
      organizationId: ORG_ID,
      actorId: ACTOR_ID,
      deleteBeforeTs: "2026-08-19T13:00:00.000Z",
      now: "2026-08-19T13:00:00.000Z",
    });
    expect(retry.deleteBeforeTs).toBe(NOW);

    const cancel = repo.identity.cancelAppDeletionSaga(activeIdentity(saga));
    const cross = repo.identity.deleteAppCascade(appScope(APP_ID), boundary(saga));
    const [cancelled, crossed] = await Promise.allSettled([cancel, cross]);
    const cancelWon = cancelled.status === "fulfilled" && cancelled.value;
    const boundaryWon = crossed.status === "fulfilled";
    expect([cancelWon, boundaryWon].filter(Boolean)).toHaveLength(1);
    if (boundaryWon) {
      expect(await repo.identity.getApp(APP_ID)).toBeNull();
    } else {
      expect(await repo.identity.getApp(APP_ID)).not.toBeNull();
    }
  });

  it("redacts the completed recovery row while retaining retry authorization", async () => {
    const saga = await beginSaga();
    await repo.identity.deleteAppCascade(appScope(APP_ID), boundary(saga));
    await repo.identity.completeAppDeletionSaga(APP_ID, NOW);

    expect(await repo.identity.getAppDeletionSaga(APP_ID)).toMatchObject({
      phase: "complete",
      organizationId: null,
      actorId: null,
      deleteBeforeTs: null,
      retryActorHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(
      await local.d1
        .prepare("SELECT organization_scope_hash FROM app_deletion_sagas WHERE app_id = ?")
        .bind(APP_ID)
        .first<{ organization_scope_hash: string }>(),
    ).toEqual({ organization_scope_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });
});

async function beginSaga() {
  return repo.identity.beginAppDeletionSaga({
    appId: APP_ID,
    organizationId: ORG_ID,
    actorId: ACTOR_ID,
    deleteBeforeTs: NOW,
    now: NOW,
  });
}

function boundary(saga: Awaited<ReturnType<typeof beginSaga>>) {
  const identity = activeIdentity(saga);
  return {
    ...identity,
    updatedAt: NOW,
  };
}

function activeIdentity(saga: Awaited<ReturnType<typeof beginSaga>>) {
  if (saga.actorId === null || saga.organizationId === null || saga.deleteBeforeTs === null) {
    throw new Error("expected active App deletion saga");
  }
  return {
    appId: saga.appId,
    actorId: saga.actorId,
    organizationId: saga.organizationId,
    deleteBeforeTs: saga.deleteBeforeTs,
  };
}
