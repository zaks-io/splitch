import { env } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import type { Principal, RateLimiter } from "@splitch/worker-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { resolveControlPlanePathSelectors } from "./path-selector-resolution";
import {
  resetOrganizationGraph,
  seedAppMember,
  seedEnvironment,
  seedOrgApp,
  seedOrgMember,
} from "./test-seeds";

const ATTACKER = "user_selector_attacker";
const OTHER_USER = "user_selector_other";
const ATTACKER_APP = "app_selector_attacker";
const VICTIM_APP = "app_selector_victim";
const allowLimiter: RateLimiter = () => ({ limited: false });

beforeEach(async () => {
  await resetOrganizationGraph(env.DB);
});

describe("path selector authorization ordering", () => {
  it("returns one indistinguishable FORBIDDEN response for unauthorized descendant probes", async () => {
    await seedOracleWorld();
    const app = testApp(principal(ATTACKER_APP, [ATTACKER_APP]));
    const paths = [
      `/apps/${VICTIM_APP}/flags/acquisition-pricing`,
      `/apps/${VICTIM_APP}/flags/no-such-flag-here`,
      `/apps/${VICTIM_APP}/envs/production`,
      `/apps/${VICTIM_APP}/envs/no-such-env`,
      `/apps/${VICTIM_APP}/envs/production/flags/x/config`,
      "/apps/app_does_not_exist/envs/production/flags/x/config",
    ];

    const responses = await Promise.all(paths.map((path) => app.request(path)));
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(403));
    expect(new Set(bodies.map((body) => JSON.stringify(body)))).toEqual(
      new Set([
        JSON.stringify({
          code: "FORBIDDEN",
          message: "credential is not scoped to this app",
          details: {},
        }),
      ]),
    );
  });

  it("applies the same pre-lookup App gate to live updates", async () => {
    await seedOracleWorld();
    const app = testApp(principal(ATTACKER_APP, [ATTACKER_APP]));
    const responses = await Promise.all([
      app.request(`/apps/${VICTIM_APP}/envs/production/live`),
      app.request(`/apps/${VICTIM_APP}/envs/no-such-env/live`),
      app.request("/apps/app_does_not_exist/envs/production/live"),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });
});

describe("path selector compatibility", () => {
  it("authorizes canonical ID and slug identically from one matching signed App scope", async () => {
    await seedReachableApp(VICTIM_APP, "sensitive");
    const app = testApp(principal(null, [VICTIM_APP]));

    const byId = await app.request(`/apps/${VICTIM_APP}/flags`);
    const bySlug = await app.request("/apps/sensitive/flags");

    expect(byId.status).toBe(200);
    expect(bySlug.status).toBe(byId.status);
    expect(await bySlug.json()).toEqual(await byId.json());
  });

  it("ignores a colliding App key outside the caller's live memberships", async () => {
    await seedReachableApp(ATTACKER_APP, "neuron");
    await seedOrgApp(env.DB, {
      orgId: "org_selector_other",
      orgName: "Other",
      orgSlug: "other",
      appId: VICTIM_APP,
      appName: "Neuron",
      appKey: "neuron",
    });
    await seedOrgMember(env.DB, {
      orgId: "org_selector_other",
      userId: OTHER_USER,
      role: "owner",
    });
    await seedAppMember(env.DB, { appId: VICTIM_APP, userId: OTHER_USER, role: "owner" });
    const app = testApp(principal(ATTACKER_APP, [ATTACKER_APP, VICTIM_APP]));

    const response = await app.request("/apps/neuron/flags");

    expect(response.status).toBe(200);
  });

  it("falls through a missing canonical-looking Environment ID to a legacy key", async () => {
    await seedReachableApp(VICTIM_APP, "sensitive");
    await seedEnvironment(env.DB, {
      appId: VICTIM_APP,
      environmentId: "env_legacy_row_id",
      key: "env_legacy_key",
    });
    const app = testApp(principal(VICTIM_APP, [VICTIM_APP]));

    const response = await app.request(`/apps/${VICTIM_APP}/envs/env_legacy_key`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "env_legacy_row_id", key: "env_legacy_key" });
  });

  it("rejects an Environment selector shared by an ID and a legacy key", async () => {
    await seedReachableApp(VICTIM_APP, "sensitive");
    await seedOrgApp(env.DB, {
      orgId: "org_selector_foreign",
      orgName: "Foreign",
      orgSlug: "foreign",
      appId: "app_selector_foreign",
      appName: "Foreign",
      appKey: "foreign",
    });
    await seedEnvironment(env.DB, {
      appId: VICTIM_APP,
      environmentId: "env_prod9",
      key: "prod",
    });
    await seedEnvironment(env.DB, {
      appId: VICTIM_APP,
      environmentId: "env_selector_collision",
      key: "env_prod9",
    });
    await seedEnvironment(env.DB, {
      appId: "app_selector_foreign",
      environmentId: "env_selector_foreign_collision",
      key: "env_prod9",
    });
    const app = testApp(principal(VICTIM_APP, [VICTIM_APP]));

    const response = await app.request(`/apps/${VICTIM_APP}/envs/env_prod9`);

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      details: { candidates: Array<{ environmentId: string; environmentKey: string }> };
    };
    expect(body).toEqual({
      code: "SELECTOR_AMBIGUOUS",
      message: 'Environment selector "env_prod9" matches more than one Environment',
      details: {
        recommendedAction: "USE_CANONICAL_ID",
        candidates: [
          { environmentId: "env_prod9", environmentKey: "prod" },
          { environmentId: "env_selector_collision", environmentKey: "env_prod9" },
        ],
      },
    });
    expect(body.details.candidates).not.toContainEqual({
      environmentId: "env_selector_foreign_collision",
      environmentKey: "env_prod9",
    });

    const byId = await app.request(`/apps/${VICTIM_APP}/envs/env_prod9?by=id`);
    expect(byId.status).toBe(200);
    await expect(byId.json()).resolves.toMatchObject({ id: "env_prod9", key: "prod" });

    const byLegacyKeyCandidateId = await app.request(
      `/apps/${VICTIM_APP}/envs/env_selector_collision`,
    );
    expect(byLegacyKeyCandidateId.status).toBe(200);
    await expect(byLegacyKeyCandidateId.json()).resolves.toMatchObject({
      id: "env_selector_collision",
      key: "env_prod9",
    });
  });

  it("merges canonical replacements into parsed params without discarding transforms", async () => {
    await seedReachableApp(VICTIM_APP, "sensitive");
    const input = { params: { appId: "parsed-sensitive", transformed: "kept" } };

    const resolved = await resolveControlPlanePathSelectors(createRepository(env.DB), {
      contract: { id: "flags_list" },
      input,
      params: { appId: "sensitive" },
      principal: principal(VICTIM_APP, [VICTIM_APP]),
      request: new Request("https://control-plane.test/apps/sensitive/flags"),
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.input).toEqual({ params: { appId: VICTIM_APP, transformed: "kept" } });
  });

  it("does not inject empty params into a route with no path params", async () => {
    const input = { query: { format: "json" } };
    const resolved = await resolveControlPlanePathSelectors(createRepository(env.DB), {
      contract: { id: "openapi_document_get" },
      input,
      params: {},
      principal: principal(null, []),
      request: new Request("https://control-plane.test/.well-known/openapi.json"),
    });

    expect(resolved).toMatchObject({ ok: true, input });
    if (resolved.ok) expect(resolved.input).toBe(input);
  });
});

function testApp(actor: Principal) {
  return createApp({
    authResolver: async () => ({ ok: true, principal: actor }),
    rateLimiter: allowLimiter,
    repo: createRepository(env.DB),
  });
}

function principal(appId: string | null, appIds: readonly string[]): Principal {
  return {
    kind: "control-plane-token",
    id: ATTACKER,
    scopes: appIds.map((id) => `app:${id}:owner`),
    orgId: null,
    appId,
    environmentId: null,
    authDoor: "device_flow",
  };
}

async function seedReachableApp(appId: string, appKey: string): Promise<void> {
  await seedOrgApp(env.DB, {
    orgId: `org_${appId}`,
    orgName: appKey,
    orgSlug: appKey,
    appId,
    appName: appKey,
    appKey,
  });
  await seedOrgMember(env.DB, { orgId: `org_${appId}`, userId: ATTACKER, role: "owner" });
  await seedAppMember(env.DB, { appId, userId: ATTACKER, role: "owner" });
}

async function seedOracleWorld(): Promise<void> {
  await seedReachableApp(ATTACKER_APP, "attacker");
  await seedOrgApp(env.DB, {
    orgId: "org_selector_victim",
    orgName: "Victim",
    orgSlug: "victim",
    appId: VICTIM_APP,
    appName: "Victim",
    appKey: "victim",
  });
  await seedEnvironment(env.DB, {
    appId: VICTIM_APP,
    environmentId: "env_selector_victim_prod",
    key: "production",
  });
  await env.DB.prepare(
    "INSERT INTO flags (id, app_id, key, name, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      "flag_selector_victim",
      VICTIM_APP,
      "acquisition-pricing",
      "Acquisition pricing",
      "2026-08-28T00:00:00.000Z",
      "2026-08-28T00:00:00.000Z",
      1,
    )
    .run();
}
