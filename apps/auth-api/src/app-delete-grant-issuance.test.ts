import { appScope, createRepository } from "@splitch/db";
import { createLocalD1 } from "@splitch/db/test-d1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAppSelectionForUser } from "./membership-authority";

/**
 * SPL-298: after a failed App cascade (FK from leftover Approval Requests),
 * grant issuance must still resolve the App from live membership — the same
 * path `/oauth2/token` uses when selecting an App.
 */

const NOW = "2026-08-04T12:00:00.000Z";
const ORG_ID = "org_grant_after_delete_fail";
const APP_ID = "app_grant_after_delete_fail";
const USER_ID = "user_grant_after_delete_fail";
const ENV_ID = "env_grant_after_delete_fail";

describe("App grant issuance after failed delete cascade (SPL-298)", () => {
  let dispose: (() => Promise<void>) | undefined;
  let repo: ReturnType<typeof createRepository>;

  beforeAll(async () => {
    const local = await createLocalD1();
    dispose = local.dispose;
    repo = createRepository(local.d1);

    await local.d1
      .prepare(
        `INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at)
         VALUES (?, 'Grant Fail Co', 'grant-fail-co', 'free', 0, ?, ?)`,
      )
      .bind(ORG_ID, NOW, NOW)
      .run();
    await local.d1
      .prepare(
        `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
         VALUES (?, ?, 'Grant Fail App', 'grant-fail-app', ?, ?)`,
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

    const created = await repo.approvals.createRequest(appScope(APP_ID), {
      id: "apr_grant_after_fail",
      operation: "update_flag_config",
      targetType: "flag_config",
      targetId: "cfg_grant_after_fail",
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
      idempotencyKey: "idem_grant_after_fail",
      requestHash: "hash_grant_after_fail",
    });
    expect(created.ok).toBe(true);

    await expect(repo.identity.deleteAppCascade(appScope(APP_ID))).rejects.toThrow(
      /FOREIGN KEY constraint failed|app delete did not reach D1/,
    );
  });

  afterAll(async () => {
    await dispose?.();
  });

  it("still exchanges an App selector against live membership after the failed cascade", async () => {
    await expect(resolveAppSelectionForUser(repo, USER_ID, APP_ID)).resolves.toEqual({
      appId: APP_ID,
      scope: `app:${APP_ID}:owner`,
    });
  });
});
