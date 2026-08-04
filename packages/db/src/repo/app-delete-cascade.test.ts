import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1";

/**
 * SPL-298: App cascade must not delete memberships when the App row DELETE fails.
 * Real migration FKs are required — the hand-written control-plane fixture schema
 * omits them and would hide the production fault.
 */

const NOW = "2026-08-04T12:00:00.000Z";
const ORG_ID = "org_app_delete_cascade";
const APP_ID = "app_app_delete_cascade";
const USER_ID = "user_app_delete_cascade";
const ENV_ID = "env_app_delete_cascade";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeAll(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  await local.d1
    .prepare(
      `INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at)
       VALUES (?, 'Cascade Co', 'cascade-co', 'free', 0, ?, ?)`,
    )
    .bind(ORG_ID, NOW, NOW)
    .run();
  await local.d1
    .prepare(
      `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
       VALUES (?, ?, 'Cascade App', 'cascade-app', ?, ?)`,
    )
    .bind(APP_ID, ORG_ID, NOW, NOW)
    .run();
  await local.d1
    .prepare(
      `INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
    )
    .bind(ORG_ID, USER_ID, NOW)
    .run();
  await local.d1
    .prepare(
      `INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
    )
    .bind(APP_ID, USER_ID, NOW)
    .run();
  await local.d1
    .prepare(
      `INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at)
       VALUES (?, ?, 'dev', 'Dev', '{}', ?, ?)`,
    )
    .bind(ENV_ID, APP_ID, NOW, NOW)
    .run();
  await local.d1
    .prepare(
      `INSERT INTO client_keys (key_id, app_id, environment_id, key_material, created_at)
       VALUES ('ck_cascade', ?, ?, 'material_cascade', ?)`,
    )
    .bind(APP_ID, ENV_ID, NOW)
    .run();
});

afterAll(async () => {
  await local.dispose();
});

describe("deleteAppCascade atomicity (SPL-298)", () => {
  it("rolls back memberships and credentials when Approval Requests block the App DELETE", async () => {
    const created = await repo.approvals.createRequest(appScope(APP_ID), {
      id: "apr_cascade_block",
      operation: "update_flag_config",
      targetType: "flag_config",
      targetId: "cfg_missing",
      targetVersion: "1",
      policyContexts: "[]",
      diff: "{}",
      status: "pending",
      proposedBy: USER_ID,
      proposedVia: "id_jag",
      proposedAt: NOW,
      resolvedAt: null,
      resultingTargetVersion: null,
      resultingResourceType: null,
      resultingResourceId: null,
      idempotencyKey: "idem_cascade_block",
      requestHash: "hash_cascade_block",
    });
    expect(created.ok).toBe(true);

    await expect(repo.identity.deleteAppCascade(appScope(APP_ID))).rejects.toThrow(
      /FOREIGN KEY constraint failed|app delete did not reach D1/,
    );

    expect(await repo.identity.getApp(APP_ID)).toMatchObject({ id: APP_ID });
    expect(await repo.identity.getAppMembership(appScope(APP_ID), USER_ID)).toMatchObject({
      role: "owner",
    });
    expect(await repo.identity.listEnvironments(appScope(APP_ID))).toHaveLength(1);
    expect(await repo.credentials.listClientKeys(envScope(APP_ID, ENV_ID))).toHaveLength(1);
  });
});
