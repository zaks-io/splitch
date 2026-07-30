import { env } from "cloudflare:workers";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  type ControlPanelOperation,
  issueControlPanelDelegation,
  parseControlPanelOperation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { SignedControlPanelEntrypoint } from "../src/index.js";

export const ORIGIN = "https://cp.splitch.test";
export const NOW = "2026-07-19T00:00:00.000Z";
export const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";

export const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

/**
 * Suites share one D1, so every id and every unique key is namespaced by
 * `suffix`. Two suites seeding concurrently must not collide.
 */
export type PanelFlagsIds = {
  suffix: string;
  orgId: string;
  appId: string;
  otherAppId: string;
  envId: string;
  otherEnvId: string;
  flagId: string;
  userId: string;
};

export function panelFlagsIds(suffix: string): PanelFlagsIds {
  return {
    suffix,
    orgId: `org_panel_flags_${suffix}`,
    appId: `app_panel_flags_${suffix}`,
    otherAppId: `app_panel_flags_other_${suffix}`,
    envId: `env_panel_flags_${suffix}`,
    otherEnvId: `env_panel_flags_other_${suffix}`,
    flagId: `flag_panel_flags_${suffix}`,
    userId: `user_panel_flags_${suffix}`,
  };
}

export function panelTestEnv(): ControlPlaneApiEnv {
  return {
    ...env,
    CONTROL_PLANE_ORIGIN: ORIGIN,
    SPLITCH_PLATFORM_TARGET: "production",
    AUTH_JWKS_URI: "https://auth.splitch.test/.well-known/jwks.json",
    CONTROL_PANEL_DELEGATION_SECRET: DELEGATION_SECRET,
    CONTROL_PLANE_ACTOR_RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as ControlPlaneApiEnv;
}

/**
 * Builds a signed panel request. `delegatedBody` defaults to `body`; passing a
 * different one is how the body-binding test forges a mismatch.
 */
export async function signedPanelRequest(
  ids: PanelFlagsIds,
  method: string,
  path: string,
  body?: unknown,
  delegatedOperation?: ControlPanelOperation,
  actorId = ids.userId,
  expiresInSeconds = 30,
  delegatedBody = body,
): Promise<Request> {
  const headers = new Headers({
    "x-splitch-panel-environment": ids.envId,
    ...(body ? { "content-type": "application/json" } : {}),
    // Mutating Control Plane routes require an Idempotency Key; the panel
    // supplies one per action, so the harness does the same.
    ...(method === "GET" ? {} : { "idempotency-key": `idem-panel-${crypto.randomUUID()}` }),
  });
  const expectedOperation = parseControlPanelOperation(method, path, ids.envId);
  if (expectedOperation) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const signedRequest = new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: delegatedBody ? JSON.stringify(delegatedBody) : undefined,
    });
    headers.set(
      CONTROL_PANEL_DELEGATION_HEADER,
      await issueControlPanelDelegation(
        signedRequest,
        delegatedOperation ?? expectedOperation,
        actorId,
        DELEGATION_SECRET,
        {
          nowSeconds: expiresInSeconds < 0 ? nowSeconds - 30 : nowSeconds,
          sessionExpiresAt: nowSeconds + expiresInSeconds,
        },
      ),
    );
  }
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function panelEntrypoint(testEnv: ControlPlaneApiEnv): SignedControlPanelEntrypoint {
  return new SignedControlPanelEntrypoint(testCtx, testEnv);
}

export async function seedAppMembership(ids: PanelFlagsIds): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)",
  )
    .bind(ids.appId, ids.userId, "owner", NOW)
    .run();
}

export async function seedPanelFlags(ids: PanelFlagsIds): Promise<void> {
  const disabledVariantId = `var_disabled_${ids.suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      // Slug from the id, not the display name: the harness seeds several Orgs
      // and a constant "panel-flags" would collide on the unique index.
    ).bind(ids.orgId, "Panel Flags", ids.orgId, "free", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(ids.appId, ids.orgId, "Panel Flags", `panel-flags-${ids.suffix}`, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(ids.otherAppId, ids.orgId, "Other App", `other-app-${ids.suffix}`, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO environments (id, app_id, key, name, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(ids.envId, ids.appId, "dev", "Development", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO environments (id, app_id, key, name, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(ids.otherEnvId, ids.otherAppId, "dev", "Development", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)",
    ).bind(ids.orgId, ids.userId, "owner", NOW),
    env.DB.prepare(
      "INSERT INTO flags (id, app_id, key, name, schema, default_variant_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(
      ids.flagId,
      ids.appId,
      "checkout-refresh",
      "Checkout Refresh",
      '{"type":"boolean"}',
      disabledVariantId,
      NOW,
      NOW,
    ),
    env.DB.prepare(
      "INSERT INTO variants (id, flag_id, name, value, created_at) VALUES (?,?,?,?,?)",
    ).bind(disabledVariantId, ids.flagId, "disabled", "false", NOW),
    env.DB.prepare(
      "INSERT INTO variants (id, flag_id, name, value, created_at) VALUES (?,?,?,?,?)",
    ).bind(`var_enabled_${ids.suffix}`, ids.flagId, "enabled", "true", NOW),
    env.DB.prepare(
      "INSERT INTO flag_configs (id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(
      `config_${ids.suffix}`,
      ids.appId,
      ids.envId,
      ids.flagId,
      1,
      '["disabled","enabled"]',
      disabledVariantId,
      NOW,
      NOW,
    ),
  ]);
  await seedAppMembership(ids);
}
