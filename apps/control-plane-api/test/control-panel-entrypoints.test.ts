import { env } from "cloudflare:workers";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  issueControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer.js";
import worker, { SignedControlPanelEntrypoint } from "../src/index.js";

const AUDIENCE = "https://cp.splitch.test";
const JWKS_URI = "https://auth.splitch.test/.well-known/jwks.json";
const NOW_MS = Date.UTC(2026, 6, 1, 12, 0, 0);
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";
const ORG = {
  orgId: "org_panel_protocol_329a",
  orgName: "Panel Protocol",
  appId: "app_panel_protocol_329a",
  appName: "Panel Protocol App",
  appKey: "panel-protocol",
};
const OWNER = "user_panel_protocol_owner_5e12";

let signer: FixtureSigner;
let testEnv: ControlPlaneApiEnv;

beforeAll(async () => {
  await seedOrgApp();
  await seedOrgMember(OWNER, "owner");
  signer = await makeFixtureSigner();
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === JWKS_URI) return Response.json(signer.jwks);
    return realFetch(input, init);
  });
  testEnv = {
    ...env,
    CONTROL_PLANE_ORIGIN: AUDIENCE,
    AUTH_JWKS_URI: JWKS_URI,
    CONTROL_PANEL_DELEGATION_SECRET: DELEGATION_SECRET,
  } as ControlPlaneApiEnv;
});

afterAll(() => vi.unstubAllGlobals());

describe("Control Panel signed binding protocol", () => {
  it("rejects a valid signed delegation on public HTTP", async () => {
    const response = await callSignedAppsCreate(worker.fetch, "signed-public");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("redeems signed delegation through the named binding entrypoint", async () => {
    const entrypoint = new SignedControlPanelEntrypoint(testCtx, testEnv);
    const response = await callSignedAppsCreate(
      (request) => entrypoint.fetch(request),
      "signed-binding",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      app: { organizationId: ORG.orgId, key: "signed-binding" },
    });
  });

  it("rejects reusable session handles on the signed binding and public HTTP", async () => {
    const tokenHash = "a".repeat(64);
    await env.SESSION_STORE.put(
      `session:${tokenHash}`,
      JSON.stringify({
        version: 2,
        userId: OWNER,
        orgs: [],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const entrypoint = new SignedControlPanelEntrypoint(testCtx, testEnv);
    for (const fetcher of [worker.fetch, (request: Request) => entrypoint.fetch(request)]) {
      const request = baseAppsCreateRequest("session-handle-refused");
      request.headers.set("x-splitch-panel-session", tokenHash);
      const response = await fetcher(
        request as Parameters<typeof worker.fetch>[0],
        testEnv,
        testCtx,
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
});

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function callSignedAppsCreate(fetcher: typeof worker.fetch, key: string): Promise<Response> {
  const request = baseAppsCreateRequest(key);
  request.headers.set(
    CONTROL_PANEL_DELEGATION_HEADER,
    await issueControlPanelDelegation(
      request,
      { id: "apps_create", orgId: ORG.orgId },
      OWNER,
      DELEGATION_SECRET,
      { sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600 },
    ),
  );
  return fetcher(request as Parameters<typeof worker.fetch>[0], testEnv, testCtx);
}

function baseAppsCreateRequest(key: string): Request {
  return new Request(`${AUDIENCE}/orgs/${ORG.orgId}/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: key, key }),
  });
}

async function seedOrgApp(): Promise<void> {
  const now = new Date(NOW_MS).toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(ORG.orgId, ORG.orgName, ORG.orgId, "free", now, now)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(ORG.appId, ORG.orgId, ORG.appName, ORG.appKey, now, now)
    .run();
}

async function seedOrgMember(userId: string, role: "owner" | "member"): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)",
  )
    .bind(ORG.orgId, userId, role, new Date(NOW_MS).toISOString())
    .run();
}
