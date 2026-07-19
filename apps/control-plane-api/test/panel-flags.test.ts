import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import worker, { ControlPanelEntrypoint } from "../src/index.js";

const ORIGIN = "https://cp.splitch.test";
const ORG_ID = "org_panel_flags_e2e";
const APP_ID = "app_panel_flags_e2e";
const OTHER_APP_ID = "app_panel_flags_other_e2e";
const ENV_ID = "env_panel_flags_e2e";
const OTHER_ENV_ID = "env_panel_flags_other_e2e";
const FLAG_ID = "flag_panel_flags_e2e";
const USER_ID = "user_panel_flags_e2e";
const SESSION_HASH = "f".repeat(64);
const NOW = "2026-07-19T00:00:00.000Z";

let testEnv: ControlPlaneApiEnv;
let entrypoint: ControlPanelEntrypoint;

beforeAll(async () => {
  await seed();
  await env.SESSION_STORE.put(
    `session:${SESSION_HASH}`,
    JSON.stringify({
      version: 2,
      userId: USER_ID,
      orgs: [],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  testEnv = { ...env, CONTROL_PLANE_ORIGIN: ORIGIN } as ControlPlaneApiEnv;
  entrypoint = new ControlPanelEntrypoint(testCtx, testEnv);
});

afterAll(() => vi.unstubAllGlobals());

describe("ControlPanelEntrypoint Flags operations", () => {
  it("lists definitions and this Environment's Configuration", async () => {
    const list = await panelRequest("GET", `/apps/${APP_ID}/flags`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [{ id: FLAG_ID, key: "checkout-refresh", variants: [{ name: "disabled" }] }],
    });

    const config = await panelRequest(
      "GET",
      `/apps/${APP_ID}/envs/${ENV_ID}/flags/${FLAG_ID}/config`,
    );
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({
      flagId: FLAG_ID,
      environmentId: ENV_ID,
      enabled: true,
      availableVariantNames: ["disabled", "enabled"],
    });
  });

  it("creates the guided boolean catalog through the authoritative Worker handler", async () => {
    const response = await panelRequest("POST", `/apps/${APP_ID}/flags`, {
      appId: APP_ID,
      key: "new-checkout",
      name: "New Checkout",
      schema: { type: "boolean" },
      variants: [
        { name: "disabled", value: false, isDefault: true },
        { name: "enabled", value: true, isDefault: false },
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      appId: APP_ID,
      key: "new-checkout",
      variants: [{ name: "disabled" }, { name: "enabled" }],
    });
  });

  it("rechecks live App membership and Environment ownership", async () => {
    await env.DB.prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(APP_ID, USER_ID)
      .run();
    const removed = await panelRequest("GET", `/apps/${APP_ID}/flags`);
    expect(removed.status).toBe(403);
    expect(await removed.json()).toMatchObject({ code: "FORBIDDEN" });
    await seedAppMembership();

    const crossApp = await panelRequest(
      "GET",
      `/apps/${APP_ID}/envs/${OTHER_ENV_ID}/flags/${FLAG_ID}/config`,
    );
    expect(crossApp.status).toBe(403);
    expect(await crossApp.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps the public Worker and unsupported binding methods closed", async () => {
    const publicResponse = await publicRequest("GET", `/apps/${APP_ID}/flags`);
    expect(publicResponse.status).toBe(401);
    expect(await publicResponse.json()).toMatchObject({ code: "UNAUTHORIZED" });

    const unsupported = await panelRequest("PATCH", `/apps/${APP_ID}/flags/${FLAG_ID}`, {
      name: "Not allowed",
    });
    expect(unsupported.status).toBe(404);
  });
});

async function panelRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return entrypoint.fetch(request(method, path, body));
}

async function publicRequest(method: string, path: string): Promise<Response> {
  return Promise.resolve(worker.fetch(request(method, path), testEnv, testCtx));
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      "x-splitch-panel-session": SESSION_HASH,
      "x-splitch-panel-environment": ENV_ID,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (id, name, plan, created_at, updated_at) VALUES (?,?,?,?,?)",
    ).bind(ORG_ID, "Panel Flags", "free", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(APP_ID, ORG_ID, "Panel Flags", "panel-flags", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(OTHER_APP_ID, ORG_ID, "Other App", "other-app", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO environments (id, app_id, key, name, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(ENV_ID, APP_ID, "dev", "Development", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO environments (id, app_id, key, name, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(OTHER_ENV_ID, OTHER_APP_ID, "dev", "Development", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)",
    ).bind(ORG_ID, USER_ID, "owner", NOW),
    env.DB.prepare(
      "INSERT INTO flags (id, app_id, key, name, schema, default_variant_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(
      FLAG_ID,
      APP_ID,
      "checkout-refresh",
      "Checkout Refresh",
      '{"type":"boolean"}',
      "var_disabled_panel",
      NOW,
      NOW,
    ),
    env.DB.prepare(
      "INSERT INTO variants (id, flag_id, name, value, created_at) VALUES (?,?,?,?,?)",
    ).bind("var_disabled_panel", FLAG_ID, "disabled", "false", NOW),
    env.DB.prepare(
      "INSERT INTO variants (id, flag_id, name, value, created_at) VALUES (?,?,?,?,?)",
    ).bind("var_enabled_panel", FLAG_ID, "enabled", "true", NOW),
    env.DB.prepare(
      "INSERT INTO flag_configs (id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(
      "config_panel_flags",
      APP_ID,
      ENV_ID,
      FLAG_ID,
      1,
      '["disabled","enabled"]',
      "var_disabled_panel",
      NOW,
      NOW,
    ),
  ]);
  await seedAppMembership();
}

async function seedAppMembership(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)",
  )
    .bind(APP_ID, USER_ID, "owner", NOW)
    .run();
}
