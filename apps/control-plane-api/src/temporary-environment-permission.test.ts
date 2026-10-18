import {
  getRoute,
  type PersonalAccessTokenGrant,
  personalAccessTokenAuthority,
} from "@splitch/contracts";
import { appScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ids, NOW, temporaryEnvironmentHarness } from "./temporary-environment-test-harness";
import { makeTestApp, makeTestRegistrar } from "./test-app-fixture";

let h: Awaited<ReturnType<typeof temporaryEnvironmentHarness>>;
let temporaryId: string;
let actor: Principal;
beforeEach(async () => {
  h = await temporaryEnvironmentHarness();
  const created = await h.create();
  if (!created.ok)
    throw new Error(`Temporary fixture create HTTP ${created.status}: ${await created.text()}`);
  temporaryId = ((await created.json()) as { id: string }).id;
  const row = await h.repo.identity.getEnvironment(appScope(ids.appId), temporaryId);
  if (!row) throw new Error("missing Temporary Environment");
  await h.repo.identity.environments.insert(appScope(ids.otherAppId), {
    ...row,
    id: "env_foreign",
    appId: ids.otherAppId,
    key: "pr-foreign",
  });
  await h.repo.identity.createAppMembership(appScope(ids.otherAppId), {
    userId: "user_temporary",
    role: "owner",
    createdAt: NOW,
  });
  actor = pat([
    { target: `app:${ids.appId}`, role: "owner", permissions: ["temporary_environments"] },
  ]);
});
afterEach(() => h?.dispose());

function pat(grants: PersonalAccessTokenGrant[]): Principal {
  const authority = personalAccessTokenAuthority(
    {
      organizations: [],
      apps: [
        { id: ids.appId, organizationId: ids.orgId, role: "owner" },
        { id: ids.otherAppId, organizationId: ids.orgId, role: "owner" },
      ],
    },
    grants,
  );
  return {
    kind: "control-plane-token",
    id: "user_temporary",
    authDoor: "personal_access_token",
    scopes: authority.scopes,
    appId: null,
    orgId: null,
    environmentId: null,
    personalAccessToken: { id: "pat_temporary", permissions: authority.permissions },
  };
}

const writes: [string, unknown][] = [
  ["environments_update", { name: "Renamed" }],
  ["environments_delete", undefined],
  ["environments_sync", { fromEnvironmentId: "production" }],
  ["flag_config_update", { enabled: false, idempotency_key: "temp-test" }],
  ["flag_targeting_rules_replace", { targetingRules: [], idempotency_key: "temp-test" }],
  [
    "flags_promote",
    { fromEnvironmentId: "production", select: { enabled: true }, idempotency_key: "temp-test" },
  ],
  ["client_key_get", undefined],
  ["client_key_update", { rateLimitRps: 20 }],
  ["client_key_rotate", undefined],
  ["api_keys_create", { scopes: ["data-plane:evaluate"] }],
  ["api_keys_revoke", {}],
];

function uncheckedRoute(operation: string, body: unknown) {
  const route = getRoute(operation);
  if (!route) throw new Error("missing route");
  const app = new Hono();
  const handler = vi.fn(() => Response.json({ unchecked: true }));
  makeTestRegistrar({
    repo: h.repo,
    nowIso: () => NOW,
    authResolver: () => ({ ok: true, principal: actor }),
  }).mount(app, route, handler);
  return {
    handler,
    request: (environmentId: string, appId: string = ids.appId, by = "") =>
      app.request(
        route.path
          .replace(":appId", appId)
          .replace(/:(?:targetEnvironmentId|environmentId)\b/, environmentId)
          .replace(":flagId", ids.flagId)
          .replace(":keyId", "cred_test") + by,
        {
          method: route.method,
          headers: { "content-type": "application/json", "idempotency-key": "temp-test" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
  };
}

async function refused(response: Response, permission: string) {
  expect(response.status, await response.clone().text()).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "FORBIDDEN",
    message: expect.stringContaining(`${permission} permission`),
  });
}

describe("central Temporary Environment enforcement with a handler that does no checks", () => {
  it.each(writes)("guards %s for every selector form and foreign App", async (operation, body) => {
    const { request, handler } = uncheckedRoute(operation, body);
    const permission = getRoute(operation)?.permission;
    if (!permission) throw new Error("missing permission");
    for (const [environmentId, by] of [
      ["production", ""],
      [ids.environmentId, ""],
      [ids.environmentId, "?by=id"],
      ["dev", ""],
      [ids.devEnvironmentId, ""],
      [ids.devEnvironmentId, "?by=id"],
      ["env_missing", ""],
      ["env_missing", "?by=id"],
    ]) {
      await refused(await request(environmentId, ids.appId, by), permission);
    }
    for (const [environmentId, by] of [
      ["pr-foreign", ""],
      ["env_foreign", ""],
      ["env_foreign", "?by=id"],
    ]) {
      await refused(await request(environmentId, ids.appId, by), permission);
      await refused(await request(environmentId, ids.otherAppId, by), permission);
    }
    expect(handler).not.toHaveBeenCalled();
    for (const [selector, by] of [
      ["pr-123", ""],
      [temporaryId, ""],
      [temporaryId, "?by=id"],
    ]) {
      expect((await request(selector, ids.appId, by)).status).toBe(200);
    }
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("resolves mixed-grant App keys before selecting permission and role", async () => {
    actor = pat([
      { target: `app:${ids.appId}`, role: "owner", permissions: ["temporary_environments"] },
      { target: `app:${ids.otherAppId}`, role: "admin", permissions: ["write"] },
    ]);
    const { request } = uncheckedRoute("environments_update", { name: "Updated" });
    expect((await request("pr-123", "config-app")).status).toBe(200);
    await refused(await request("production", "config-app"), "write");
    expect((await request("pr-foreign", "other-config-app")).status).toBe(200);
  });

  it("preserves ordinary write and credentials authority on both kinds", async () => {
    actor = pat([
      { target: `app:${ids.appId}`, role: "owner", permissions: ["write", "credentials"] },
    ]);
    for (const [operation, body] of writes.filter(([op]) => op !== "environments_delete")) {
      const { request } = uncheckedRoute(operation, body);
      expect((await request(temporaryId)).status).toBe(200);
      expect((await request(ids.environmentId, ids.appId, "?by=id")).status).toBe(200);
    }
  });

  it("requires temporary in the real create handler", async () => {
    const app = makeTestApp({ ...h, authResolver: () => ({ ok: true, principal: actor }) });
    const response = await app.request(`/apps/${ids.appId}/envs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "permanent-refused" }),
    });
    await refused(response, "write");
    expect(
      await h.repo.identity.getEnvironmentByKey(appScope(ids.appId), "permanent-refused"),
    ).toBeNull();
  });
});
