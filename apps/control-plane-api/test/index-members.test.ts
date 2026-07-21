import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer.js";
import worker, { ControlPanelEntrypoint } from "../src/index.js";
import { memberProfileCacheKey } from "../src/member-profile-cache.js";

const AUDIENCE = "https://cp.splitch.test";
const JWKS_URI = "https://auth.splitch.test/.well-known/jwks.json";
const NOW_MS = Date.UTC(2026, 6, 1, 12, 0, 0);

const ORG = {
  orgId: "org_index_members_241b",
  orgName: "Index Members",
  appId: "app_index_members_241b",
  appName: "Index Members App",
  appKey: "index-members",
};

const OWNER = "user_index_owner_1c91";
const NEW_MEMBER = "user_index_new_5b72";

let signer: FixtureSigner;
let testEnv: ControlPlaneApiEnv;

beforeAll(async () => {
  await seedOrgApp(env.DB, ORG);
  await seedOrgMember(env.DB, { orgId: ORG.orgId, userId: OWNER, role: "owner" });
  await cacheMemberProfile(OWNER, "owner@index.test");
  await cacheMemberProfile(NEW_MEMBER, "new@index.test");

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
  } as ControlPlaneApiEnv;
});

afterAll(() => vi.unstubAllGlobals());

describe("index.ts: member endpoints use the live session-cache profile resolver", () => {
  it("round-trips member list and add through the default Worker export", async () => {
    const jwt = await token(OWNER, [`org:${ORG.orgId}:owner`]);

    const list = await call("GET", `/orgs/${ORG.orgId}/members`, jwt);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [expect.objectContaining({ id: OWNER, email: "owner@index.test", role: "owner" })],
    });

    const add = await call("POST", `/orgs/${ORG.orgId}/members`, jwt, {
      userId: NEW_MEMBER,
      role: "member",
    });
    expect(add.status).toBe(200);
    expect(await add.json()).toMatchObject({
      id: NEW_MEMBER,
      email: "new@index.test",
      organizationId: ORG.orgId,
      role: "member",
    });
  });
});

describe("index.ts: Control Panel binding boundary", () => {
  it("rejects a valid panel session on the public Worker export", async () => {
    const sessionHash = "a".repeat(64);
    await storePanelSession(sessionHash);

    const response = await callAppsCreate(worker.fetch, sessionHash, "public-replay");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("redeems a valid panel session only through the named binding entrypoint", async () => {
    const sessionHash = "b".repeat(64);
    await storePanelSession(sessionHash);
    const entrypoint = new ControlPanelEntrypoint(testCtx, testEnv);

    const response = await callAppsCreate(
      (request) => entrypoint.fetch(request),
      sessionHash,
      "binding-create",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      app: { organizationId: ORG.orgId, key: "binding-create" },
    });
  });

  it("does not expose the panel Experiments operation through public HTTP", async () => {
    const response = await worker.fetch(
      panelExperimentsRequest("c".repeat(64)) as unknown as Parameters<typeof worker.fetch>[0],
      testEnv,
      testCtx,
    );

    expect(response.status).toBe(404);
  });

  it("rejects bearer material on the panel Experiments binding operation", async () => {
    const entrypoint = new ControlPanelEntrypoint(testCtx, testEnv);
    const request = panelExperimentsRequest("d".repeat(64));
    request.headers.set("authorization", "Bearer must-not-forward");

    const response = await entrypoint.fetch(request);

    expect(response.status).toBe(404);
  });
});

async function token(sub: string, scopes: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signer.sign({
    sub,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: now,
    exp: now + 3600,
    scopes,
  });
}

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function call(method: string, path: string, jwt: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    worker.fetch(
      new Request(`${AUDIENCE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${jwt}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }) as unknown as Parameters<typeof worker.fetch>[0],
      testEnv,
      testCtx,
    ),
  );
}

async function callAppsCreate(
  fetcher: (
    request: Request,
    env: ControlPlaneApiEnv,
    ctx: ExecutionContext,
  ) => Response | Promise<Response>,
  sessionHash: string,
  key: string,
): Promise<Response> {
  return fetcher(
    new Request(`${AUDIENCE}/orgs/${ORG.orgId}/apps`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-splitch-panel-session": sessionHash,
      },
      body: JSON.stringify({ organizationId: ORG.orgId, name: key, key }),
    }),
    testEnv,
    testCtx,
  );
}

async function storePanelSession(sessionHash: string): Promise<void> {
  await env.SESSION_STORE.put(
    `session:${sessionHash}`,
    JSON.stringify({
      version: 2,
      userId: OWNER,
      orgs: [],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
}

function panelExperimentsRequest(sessionHash: string): Request {
  return new Request(`${AUDIENCE}/control-panel/experiments/list`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-splitch-panel-session": sessionHash,
    },
    body: JSON.stringify({ appId: ORG.appId, environmentId: "env_index_members" }),
  });
}

async function cacheMemberProfile(userId: string, email: string): Promise<void> {
  await env.SESSION_STORE.put(memberProfileCacheKey(userId), JSON.stringify({ email }));
}

async function seedOrgApp(d1: D1Database, row: typeof ORG): Promise<void> {
  const now = new Date(NOW_MS).toISOString();
  await d1
    .prepare(
      "INSERT OR IGNORE INTO organizations (id, name, plan, created_at, updated_at) VALUES (?,?,?,?,?)",
    )
    .bind(row.orgId, row.orgName, "free", now, now)
    .run();
  await d1
    .prepare(
      "INSERT OR IGNORE INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(row.appId, row.orgId, row.appName, row.appKey, now, now)
    .run();
}

async function seedOrgMember(
  d1: D1Database,
  row: { orgId: string; userId: string; role: "owner" | "admin" | "member" },
): Promise<void> {
  await d1
    .prepare(
      "INSERT OR IGNORE INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)",
    )
    .bind(row.orgId, row.userId, row.role, new Date(NOW_MS).toISOString())
    .run();
}
