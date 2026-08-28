import { env } from "cloudflare:workers";
import { appScope, createRepository, envScope } from "@splitch/db";
import {
  defaultAppEntityIdentityRecordKey,
  mintInitialAppIdentityRecord,
  wrapAppIdentityRecord,
} from "@splitch/privacy";
import { expect } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { McpEntrypoint } from "../src/index.js";
import { seedAppMember, seedEnvironment, seedOrgApp, seedOrgMember } from "../src/test-seeds.js";

export const AUDIENCE = "https://cp.splitch.test";
export const MCP_DELEGATION_SECRET = "d".repeat(32);
export const OWNER = "user_index_owner_1c91";
export const TENANT_A = {
  orgId: "org_mcp_door_a_241b",
  orgName: "MCP Door Alpha",
  appId: "app_mcp_door_a_241b",
  appName: "MCP Door Alpha App",
  appKey: "mcp-door-alpha",
  environmentKey: "alpha",
  environmentId: "env_mcp_door_a_241b",
  experimentId: "exp_mcp_door_a_241b",
  flagId: "flag_mcp_door_a_241b",
  flagKey: "alpha-checkout",
  runId: "run_mcp_door_a_241b",
};
export const TENANT_B = {
  orgId: "org_mcp_door_b_7f62",
  orgName: "MCP Door Beta",
  appId: "app_mcp_door_b_7f62",
  appName: "MCP Door Beta App",
  appKey: "mcp-door-beta",
  environmentKey: "beta",
  environmentId: "env_mcp_door_b_7f62",
  experimentId: "exp_mcp_door_b_7f62",
  flagId: "flag_mcp_door_b_7f62",
  flagKey: "beta-search",
  runId: "run_mcp_door_b_7f62",
};

export const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

export async function setupMcpDoorTestEnv(): Promise<ControlPlaneApiEnv> {
  await seedTenant(env.DB, TENANT_A, OWNER);
  await seedTenant(env.DB, TENANT_B, "user_mcp_door_b_owner_7f62");
  return {
    ...env,
    CONTROL_PLANE_ORIGIN: AUDIENCE,
    MCP_CONTROL_PLANE_DELEGATION_SECRET: MCP_DELEGATION_SECRET,
    SPLITCH_PLATFORM_TARGET: "local",
  } as ControlPlaneApiEnv;
}

interface TenantFixture {
  orgId: string;
  orgName: string;
  appId: string;
  appName: string;
  appKey: string;
  environmentKey: string;
  environmentId: string;
  experimentId: string;
  flagId: string;
  flagKey: string;
  runId: string;
}

async function seedTenant(d1: D1Database, tenant: TenantFixture, owner: string): Promise<void> {
  const now = new Date(Date.UTC(2026, 6, 1, 12, 0, 0)).toISOString();
  await seedOrgApp(d1, tenant);
  await seedOrgMember(d1, { orgId: tenant.orgId, userId: owner, role: "owner" });
  await seedAppMember(d1, { appId: tenant.appId, userId: owner, role: "owner" });
  await seedEnvironment(d1, {
    appId: tenant.appId,
    environmentId: tenant.environmentId,
    key: tenant.environmentKey,
  });
  const rootSecret = env.EVALUATION_PRIVACY_SALT;
  if (typeof rootSecret !== "string" || rootSecret.length === 0) {
    throw new Error("MCP fixture requires EVALUATION_PRIVACY_SALT");
  }
  const identity = await wrapAppIdentityRecord(
    mintInitialAppIdentityRecord(rootSecret),
    rootSecret,
    tenant.appId,
  );
  await env.CONFIG_STORE.put(
    defaultAppEntityIdentityRecordKey(tenant.appId),
    JSON.stringify(identity),
  );

  const repo = createRepository(d1);
  const controlVariantId = `${tenant.flagId}_control`;
  await repo.flags.flags.insert(appScope(tenant.appId), {
    id: tenant.flagId,
    appId: tenant.appId,
    key: tenant.flagKey,
    name: `${tenant.appName} Flag`,
    schema: JSON.stringify({ type: "boolean" }),
    defaultVariantId: controlVariantId,
    createdAt: now,
    updatedAt: now,
  });
  await repo.flags.addVariant(appScope(tenant.appId), tenant.flagId, {
    id: controlVariantId,
    name: "control",
    value: JSON.stringify(false),
    createdAt: now,
  });
  const scope = envScope(tenant.appId, tenant.environmentId);
  await repo.experiments.experiments.insert(scope, {
    id: tenant.experimentId,
    appId: tenant.appId,
    environmentId: tenant.environmentId,
    key: `${tenant.appKey}-experiment`,
    flagId: tenant.flagId,
    name: `${tenant.appName} Experiment`,
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: tenant.runId,
    createdAt: now,
    updatedAt: now,
  });
  await repo.experiments.runs.insert(scope, {
    id: tenant.runId,
    appId: tenant.appId,
    environmentId: tenant.environmentId,
    experimentId: tenant.experimentId,
    runNumber: 1,
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    salt: `${tenant.appKey}-salt`,
    allocation: JSON.stringify({ control: 50, treatment: 50 }),
    variantSet: JSON.stringify([{ id: controlVariantId, name: "control", value: false }]),
    controlVariantId,
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: `${tenant.appKey}-hash`,
    startedAt: now,
    createdAt: now,
  });
}

export async function callMcpTool(
  targetEnv: ControlPlaneApiEnv,
  operationId: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const mcpModule = (await import(
    new URL("../../mcp-server/src/mcp-handler.ts", import.meta.url).href
  )) as {
    handleMcpServerRequest(options: Record<string, unknown>): Promise<Response>;
  };
  const entrypoint = new McpEntrypoint(testCtx, targetEnv);
  const response = await mcpModule.handleMcpServerRequest({
    request: new Request("https://mcp.local/mcp", {
      method: "POST",
      headers: { authorization: "Bearer local-mcp-token", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: operationId, arguments: arguments_ },
      }),
    }),
    service: "splitch-mcp-server",
    platformTarget: "local",
    tokenVerifier: {
      verify: async () => ({
        subject: OWNER,
        scopes: [`app:${TENANT_A.appId}:admin`],
        authDoor: "id_jag",
      }),
    },
    revocations: { isRevoked: async () => false },
    controlPlaneFetch: (request: RequestInfo | URL, init?: RequestInit) =>
      entrypoint.fetch(request instanceof Request ? request : new Request(request, init)),
    controlPlaneDelegationSecret: MCP_DELEGATION_SECRET,
  });

  expect(response.status).toBe(200);
  return response.json();
}

export function recordingBinding(requests: Request[], body: unknown): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json(body);
    },
  } as unknown as Fetcher;
}
