import { env } from "cloudflare:workers";
import { createMcpDelegationHeader, MCP_DELEGATION_HEADER } from "@splitch/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer.js";
import worker, { ControlPanelEntrypoint, McpEntrypoint } from "../src/index.js";
import { memberProfileCacheKey } from "../src/member-profile-cache.js";

const AUDIENCE = "https://cp.splitch.test";
const JWKS_URI = "https://auth.splitch.test/.well-known/jwks.json";
const NOW_MS = Date.UTC(2026, 6, 1, 12, 0, 0);
const MCP_DELEGATION_SECRET = "d".repeat(32);

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
    MCP_CONTROL_PLANE_DELEGATION_SECRET: MCP_DELEGATION_SECRET,
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
});

describe("index.ts: MCP service-binding boundary", () => {
  it("dispatches the local MCP fleet through the real named entrypoint", async () => {
    const mcpModule = (await import(
      new URL("../../mcp-server/src/mcp-handler.ts", import.meta.url).href
    )) as {
      handleMcpServerRequest(options: Record<string, unknown>): Promise<Response>;
    };
    const entrypoint = new McpEntrypoint(testCtx, testEnv);
    const response = await mcpModule.handleMcpServerRequest({
      request: new Request("https://mcp.local/mcp", {
        method: "POST",
        headers: { authorization: "Bearer local-mcp-token", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "flags_list", arguments: { appId: ORG.appId } },
        }),
      }),
      service: "splitch-mcp-server",
      platformTarget: "local",
      tokenVerifier: {
        verify: async () => ({
          subject: OWNER,
          scopes: [`app:${ORG.appId}:admin`, "app:app_unrelated:owner", "org:org_unrelated:owner"],
        }),
      },
      revocations: { isRevoked: async () => false },
      controlPlaneFetch: (request: RequestInfo | URL, init?: RequestInit) =>
        entrypoint.fetch(request instanceof Request ? request : new Request(request, init)),
      controlPlaneDelegationSecret: MCP_DELEGATION_SECRET,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { structuredContent: { items: [] } },
    });
  });

  it("rejects delegation publicly, accepts it once on the named entrypoint, then rejects replay", async () => {
    const request = new Request(`${AUDIENCE}/apps/${ORG.appId}/flags`);
    request.headers.set(
      MCP_DELEGATION_HEADER,
      await createMcpDelegationHeader({
        operationId: "flags_list",
        actor: { subject: OWNER, scopes: [`app:${ORG.appId}:admin`] },
        request,
        secret: MCP_DELEGATION_SECRET,
        jti: "index-members-delegation",
      }),
    );

    const publicResponse = await worker.fetch(request.clone(), testEnv, testCtx);
    expect(publicResponse.status).toBe(401);

    const entrypoint = new McpEntrypoint(testCtx, testEnv);
    const accepted = await entrypoint.fetch(request.clone());
    expect(accepted.status).toBe(200);

    const replayed = await entrypoint.fetch(request.clone());
    expect(replayed.status).toBe(401);
  });

  it("fails closed when the delegation secret or replay binding is missing", async () => {
    const request = new Request(`${AUDIENCE}/apps/${ORG.appId}/flags`);
    const missingSecret = new McpEntrypoint(testCtx, {
      ...testEnv,
      MCP_CONTROL_PLANE_DELEGATION_SECRET: undefined,
    });
    await expect(missingSecret.fetch(request.clone())).rejects.toThrow(
      "MCP_CONTROL_PLANE_DELEGATION_SECRET is required",
    );

    const missingReplay = new McpEntrypoint(testCtx, {
      ...testEnv,
      MCP_DELEGATION_REPLAY: undefined,
    });
    await expect(missingReplay.fetch(request)).rejects.toThrow("MCP_DELEGATION_REPLAY is required");
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
