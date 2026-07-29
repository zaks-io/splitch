import { env } from "cloudflare:workers";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  issueControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PANEL_SESSION_HEADER } from "../src/auth-resolver.js";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer.js";
import worker, { ControlPanelEntrypoint, SignedControlPanelEntrypoint } from "../src/index.js";

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
const MEMBER = "user_panel_protocol_member_6f23";

let signer: FixtureSigner;
let testEnv: ControlPlaneApiEnv;

beforeAll(async () => {
  await seedOrgApp();
  await seedOrgMember(OWNER, "owner");
  await seedOrgMember(MEMBER, "member");
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

describe("Control Panel binding protocol rollout", () => {
  it("rejects a valid signed delegation on public HTTP", async () => {
    const response = await callSignedAppsCreate(worker.fetch, "signed-public");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("redeems signed V2 on both compatibility and final Control Plane versions", async () => {
    for (const [key, targetEnv] of [
      ["signed-compat", compatibilityEnv()],
      ["signed-final", testEnv],
    ] as const) {
      const entrypoint = new SignedControlPanelEntrypoint(testCtx, targetEnv);
      const response = await callSignedAppsCreate((request) => entrypoint.fetch(request), key);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ app: { organizationId: ORG.orgId, key } });
    }
  });

  it("keeps predecessor session redemption closed in final V2", async () => {
    const tokenHash = await storeBasePanelSession(OWNER, "a");
    const response = await callBasePanelAppsCreate(
      new ControlPanelEntrypoint(testCtx, testEnv),
      tokenHash,
      "base-disabled",
    );

    expect(response.status).toBe(404);
  });

  it("redeems the exact base Panel request in compatibility mode", async () => {
    const tokenHash = await storeBasePanelSession(OWNER, "b");
    const response = await callBasePanelAppsCreate(
      compatibilityEntrypoint(),
      tokenHash,
      "base-compat",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      app: { organizationId: ORG.orgId, key: "base-compat" },
    });
  });

  it("rechecks live Org membership after session redemption", async () => {
    const tokenHash = await storeBasePanelSession(MEMBER, "c");
    const response = await callBasePanelAppsCreate(
      compatibilityEntrypoint(),
      tokenHash,
      "base-member",
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects the base Panel session shape on public HTTP", async () => {
    const tokenHash = await storeBasePanelSession(OWNER, "d");
    const response = await worker.fetch(
      basePanelAppsCreateRequest(tokenHash, "base-public") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      testEnv,
      testCtx,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("fails closed for unsupported operations while compatibility is active", async () => {
    const tokenHash = await storeBasePanelSession(OWNER, "e");
    const response = await compatibilityEntrypoint().fetch(
      new Request(`${AUDIENCE}/orgs/${ORG.orgId}/apps`, {
        headers: { [PANEL_SESSION_HEADER]: tokenHash },
      }),
    );

    expect(response.status).toBe(404);
  });

  it("closes the compatibility entrypoint at its deadline", async () => {
    const tokenHash = await storeBasePanelSession(OWNER, "f");
    const entrypoint = new ControlPanelEntrypoint(testCtx, {
      ...testEnv,
      CONTROL_PANEL_LEGACY_SESSION_EXPIRES_AT: String(Math.floor(Date.now() / 1000) - 1),
      CONTROL_PANEL_LEGACY_SESSION_MODE: "bounded-rollout",
    });

    expect(await callBasePanelAppsCreate(entrypoint, tokenHash, "base-expired")).toMatchObject({
      status: 404,
    });
  });

  it("rejects unknown, malformed, and expired session handles", async () => {
    const expired = await storeBasePanelSession(OWNER, "1", Math.floor(Date.now() / 1000) - 1);

    for (const [index, tokenHash] of [expired, "0".repeat(64), "not-a-session-handle"].entries()) {
      const response = await callBasePanelAppsCreate(
        compatibilityEntrypoint(),
        tokenHash,
        `base-bad-${index}`,
      );
      expect(response.status).toBe(401);
    }
  });
});

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function compatibilityEnv(): ControlPlaneApiEnv {
  return {
    ...testEnv,
    CONTROL_PANEL_LEGACY_SESSION_EXPIRES_AT: String(Math.floor(Date.now() / 1000) + 300),
    CONTROL_PANEL_LEGACY_SESSION_MODE: "bounded-rollout",
  };
}

function compatibilityEntrypoint(): ControlPanelEntrypoint {
  return new ControlPanelEntrypoint(testCtx, compatibilityEnv());
}

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

function callBasePanelAppsCreate(
  entrypoint: ControlPanelEntrypoint,
  tokenHash: string,
  key: string,
): Promise<Response> {
  return entrypoint.fetch(basePanelAppsCreateRequest(tokenHash, key));
}

/** Exact request shape emitted by origin/main's panelSessionFetch predecessor. */
function basePanelAppsCreateRequest(tokenHash: string, key: string): Request {
  const request = baseAppsCreateRequest(key);
  request.headers.set(PANEL_SESSION_HEADER, tokenHash);
  return request;
}

function baseAppsCreateRequest(key: string): Request {
  return new Request(`${AUDIENCE}/orgs/${ORG.orgId}/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: ORG.orgId, name: key, key }),
  });
}

async function storeBasePanelSession(
  userId: string,
  hashCharacter: string,
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
): Promise<string> {
  const tokenHash = hashCharacter.repeat(64);
  await env.SESSION_STORE.put(
    `session:${tokenHash}`,
    JSON.stringify({ version: 2, userId, orgs: [], expiresAt }),
  );
  return tokenHash;
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
