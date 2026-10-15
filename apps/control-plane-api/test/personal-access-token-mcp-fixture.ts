import { env } from "cloudflare:workers";
import {
  createMcpDelegationHeader,
  MCP_DELEGATION_HEADER,
  type PersonalAccessTokenGrant,
} from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { McpEntrypoint } from "../src/index.js";
import {
  AUDIENCE,
  MCP_DELEGATION_SECRET,
  OWNER,
  setupMcpDoorTestEnv,
  TENANT_A,
  testCtx,
} from "./index-mcp-fixtures.js";

export const TOKEN_ID = `pat_${"a".repeat(32)}`;
const TOKEN_HASH = "f".repeat(64);
let testEnv: ControlPlaneApiEnv;
const repo = () => createRepository(env.DB);

export async function setupPatMcpFixture(overrides: Partial<ControlPlaneApiEnv> = {}) {
  testEnv = { ...(await setupMcpDoorTestEnv()), ...overrides };
}

export async function resetPatMcpToken() {
  await env.DB.prepare("DELETE FROM personal_access_tokens").run();
  await seedToken([{ target: `app:${TENANT_A.appId}`, role: "owner", permissions: [] }]);
}

export async function seedToken(
  grants: PersonalAccessTokenGrant[],
  overrides: { userId?: string; expiresAt?: string | null } = {},
): Promise<void> {
  await repo().personalAccessTokens.insert({
    id: TOKEN_ID,
    userId: overrides.userId ?? OWNER,
    name: "door",
    tokenHash: TOKEN_HASH,
    grants: JSON.stringify(grants),
    expiresAt: overrides.expiresAt === undefined ? null : overrides.expiresAt,
    createdAt: new Date().toISOString(),
  });
}

let jti = 0;
export async function call(
  operationId: string,
  method: string,
  path: string,
  body?: unknown,
  tokenHash = TOKEN_HASH,
): Promise<Response> {
  const request = new Request(`${AUDIENCE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  if (body && typeof body === "object" && "idempotency_key" in body) {
    request.headers.set("idempotency-key", String(body.idempotency_key));
  }
  request.headers.set(
    MCP_DELEGATION_HEADER,
    await createMcpDelegationHeader({
      operationId,
      actor: {
        subject: OWNER,
        scopes: [],
        liveMembership: true,
        authDoor: "personal_access_token",
        personalAccessTokenId: TOKEN_ID,
        personalAccessTokenHash: tokenHash,
      },
      request,
      secret: MCP_DELEGATION_SECRET,
      jti: `pat-door-delegation-${++jti}-${Date.now()}`,
    }),
  );
  return new McpEntrypoint(testCtx, testEnv).fetch(request);
}
