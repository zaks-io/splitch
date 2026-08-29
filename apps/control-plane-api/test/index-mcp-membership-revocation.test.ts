import type { ErrorResponse } from "@splitch/contracts";
import { appScope, createRepository } from "@splitch/db";
import { beforeAll, describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { McpEntrypoint } from "../src/index.js";
import { makeMembershipCacheInvalidator } from "../src/membership-cache.js";
import { seedAppMember, seedOrgApp, seedOrgMember } from "../src/test-seeds.js";
import {
  MCP_DELEGATION_SECRET,
  OWNER,
  setupMcpDoorTestEnv,
  TENANT_A,
  testCtx,
} from "./index-mcp-fixtures.js";

/**
 * SPL-482: the MCP Control Plane door copies minted scopes onto a short-lived
 * delegation. Live membership must still be rechecked so App removal fails the
 * next tool call, not at token expiry.
 */

const REVOKE = {
  orgId: "org_mcp_membership_revocation",
  orgName: "MCP Membership Revocation",
  appId: "app_mcp_membership_revocation",
  appName: "MCP Membership Revocation App",
  appKey: "mcp-membership-revocation",
};
const ACTOR = "user_mcp_membership_revocation";

let testEnv: ControlPlaneApiEnv;

beforeAll(async () => {
  testEnv = await setupMcpDoorTestEnv();
  await seedOrgApp(testEnv.DB, REVOKE);
  await seedOrgMember(testEnv.DB, { orgId: REVOKE.orgId, userId: ACTOR, role: "admin" });
  await seedAppMember(testEnv.DB, { appId: REVOKE.appId, userId: ACTOR, role: "admin" });
});

describe("index.ts: MCP door rechecks live membership", () => {
  it("keeps apps_get working while membership exists, then refuses the same actor scopes after App removal", async () => {
    const allowed = await callAppsGet(ACTOR, [`app:${REVOKE.appId}:admin`]);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({
      result: { structuredContent: { id: REVOKE.appId } },
    });

    const repo = createRepository(testEnv.DB);
    await repo.identity.deleteAppMembership(appScope(REVOKE.appId), ACTOR);
    await makeMembershipCacheInvalidator(testEnv.SESSION_STORE).invalidate(ACTOR);

    const refused = await callAppsGet(ACTOR, [`app:${REVOKE.appId}:admin`]);
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          code: "FORBIDDEN" satisfies ErrorResponse["code"],
          message: "live membership is required",
          details: {},
        },
      },
    });
  });

  it("invalidates derived App access when the Organization membership is removed", async () => {
    const orgActor = "user_mcp_membership_revocation_org";
    await seedOrgMember(testEnv.DB, { orgId: REVOKE.orgId, userId: orgActor, role: "admin" });
    await seedAppMember(testEnv.DB, { appId: REVOKE.appId, userId: orgActor, role: "admin" });

    const allowed = await callAppsGet(orgActor, [`app:${REVOKE.appId}:admin`]);
    expect(allowed.body).toMatchObject({
      result: { structuredContent: { id: REVOKE.appId } },
    });

    const repo = createRepository(testEnv.DB);
    expect(await repo.identity.deleteOrgMembership(REVOKE.orgId, orgActor)).toBe(1);
    expect(await repo.identity.getAppMembership(appScope(REVOKE.appId), orgActor)).not.toBeNull();
    await makeMembershipCacheInvalidator(testEnv.SESSION_STORE).invalidate(orgActor);

    const refused = await callAppsGet(orgActor, [`app:${REVOKE.appId}:admin`]);
    expect(refused.body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: "FORBIDDEN" satisfies ErrorResponse["code"] },
      },
    });
  });

  it("leaves an unrelated App actor working after another membership is removed", async () => {
    const stillAllowed = await callAppsGet(OWNER, [`app:${TENANT_A.appId}:admin`]);
    expect(stillAllowed.body).toMatchObject({
      result: { structuredContent: { id: TENANT_A.appId } },
    });
  });
});

async function callAppsGet(
  subject: string,
  scopes: string[],
): Promise<{ status: number; body: Record<string, unknown> }> {
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
        params: { name: "apps_get", arguments: { appId: scopesAppId(scopes) } },
      }),
    }),
    service: "splitch-mcp-server",
    platformTarget: "local",
    tokenVerifier: {
      verify: async () => ({
        subject,
        scopes,
        authDoor: "id_jag",
      }),
    },
    revocations: { isRevoked: async () => false },
    controlPlaneFetch: (request: RequestInfo | URL, init?: RequestInit) =>
      entrypoint.fetch(request instanceof Request ? request : new Request(request, init)),
    controlPlaneDelegationSecret: MCP_DELEGATION_SECRET,
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function scopesAppId(scopes: string[]): string {
  const match = /^app:([^:]+):/.exec(scopes[0] ?? "");
  if (!match?.[1]) throw new Error("expected an App scope");
  return match[1];
}
