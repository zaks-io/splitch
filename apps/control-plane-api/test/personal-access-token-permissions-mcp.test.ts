import { env } from "cloudflare:workers";
import { appScope, createRepository, envScope } from "@splitch/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OWNER, TENANT_A } from "./index-mcp-fixtures";
import {
  call,
  resetPatMcpToken,
  seedToken,
  setupPatMcpFixture,
} from "./personal-access-token-mcp-fixture";

beforeAll(() => setupPatMcpFixture());
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM personal_access_tokens").run();
  await seedToken([{ target: `app:${TENANT_A.appId}`, role: "admin", permissions: ["write"] }]);
});

const app = `/apps/${TENANT_A.appId}`;
const environment = `${app}/envs/${TENANT_A.environmentId}`;

describe("permission enforcement through the MCP entrypoint", () => {
  it.each([
    [
      "api_keys_create",
      "POST",
      `${environment}/api-keys`,
      "credentials",
      { scopes: ["data-plane:evaluate"] },
    ],
    ["client_key_rotate", "POST", `${environment}/client-key/revoke`, "credentials", {}],
    [
      "sentry_secret_rotations_create",
      "POST",
      `/orgs/${TENANT_A.orgId}/integrations/sentry/installations/00000000-0000-4000-8000-000000000001/secret-rotations`,
      "credentials",
      { rotationId: "00000000-0000-4000-8000-000000000002" },
    ],
    ["flags_delete", "DELETE", `${app}/flags/${TENANT_A.flagId}`, "delete", undefined],
    [
      "app_members_add",
      "POST",
      `${app}/members`,
      "members",
      { userId: "user_pat_invited", role: "member" },
    ],
    ["app_privacy_export", "POST", `${app}/privacy/export`, "privacy", undefined],
  ])(
    "refuses %s and names its permission and target",
    async (operation, method, path, permission, body) => {
      const response = await call(operation as string, method as string, path as string, body);
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining(permission as string),
      });
      expect(
        await createRepository(env.DB).flags.getFlag(appScope(TENANT_A.appId), TENANT_A.flagId),
      ).not.toBeNull();
    },
  );

  it("creates and promotes a Flag using only write", async () => {
    const response = await call("flags_create", "POST", `${app}/flags`, {
      appId: TENANT_A.appId,
      name: "Permission smoke",
      key: "permission-smoke",
      lifecycleClass: "ops",
      variants: [
        { name: "off", value: false, isDefault: true },
        { name: "on", value: true, isDefault: false },
      ],
      idempotency_key: "pat-permission-create",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const flag = (await response.json()) as { id: string };
    const repo = createRepository(env.DB);
    const target = await repo.identity.environments.insert(appScope(TENANT_A.appId), {
      id: "env_pat_permission_target",
      appId: TENANT_A.appId,
      key: "permission-target",
      name: "Permission target",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const source = await repo.flags.getFlagConfig(
      envScope(TENANT_A.appId, TENANT_A.environmentId),
      flag.id,
    );
    if (!source) throw new Error("new Flag source configuration missing");
    await repo.flags.flagConfigs.insert(envScope(TENANT_A.appId, target.id), {
      ...source,
      id: "flag_config_pat_permission_target",
      environmentId: target.id,
    });
    const promoted = await call(
      "flags_promote",
      "POST",
      `${app}/envs/${target.id}/flags/${flag.id}/promote`,
      {
        fromEnvironmentId: TENANT_A.environmentId,
        select: { enabled: true },
        review: { action: "approve_and_apply" },
        idempotency_key: "pat-permission-promote",
      },
    );
    expect(promoted.status, await promoted.clone().text()).toBe(200);
  });

  it("authorizes slugs and canonical IDs identically and sees live demotion next call", async () => {
    for (const selector of [TENANT_A.appId, TENANT_A.appKey]) {
      const response = await call("apps_update", "PATCH", `/apps/${selector}`, {
        name: "Permission rename",
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    await env.DB.prepare(
      "UPDATE app_memberships SET role = 'member' WHERE app_id = ? AND user_id = ?",
    )
      .bind(TENANT_A.appId, OWNER)
      .run();
    try {
      expect((await call("apps_update", "PATCH", app, { name: "Must refuse" })).status).toBe(403);
    } finally {
      await env.DB.prepare(
        "UPDATE app_memberships SET role = 'owner' WHERE app_id = ? AND user_id = ?",
      )
        .bind(TENANT_A.appId, OWNER)
        .run();
    }
  });

  it("keeps client_key_get forbidden for a read-only token", async () => {
    await resetPatMcpToken();
    const response = await call("client_key_get", "GET", `${environment}/client-key`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("write"),
    });
  });
});
