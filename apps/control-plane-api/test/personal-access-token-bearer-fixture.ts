import { env } from "cloudflare:workers";
import type { PersonalAccessTokenGrant } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { vi } from "vitest";
import { sha256Hex } from "../src/credential-cache";
import type { ControlPlaneApiEnv } from "../src/env";
import worker from "../src/index";
import { writePersonalAccessTokenCache } from "../src/personal-access-token-store";
import { AUDIENCE, OWNER, setupMcpDoorTestEnv, TENANT_A, testCtx } from "./index-mcp-fixtures";

export const TOKEN_ID = `pat_${"3".repeat(32)}`;
export const SECRET = `spl_pat_${"3".repeat(64)}`;
export const repo = () => createRepository(env.DB);

export async function bearerFixture(overrides: Partial<ControlPlaneApiEnv> = {}) {
  const targetEnv = await setupMcpDoorTestEnv();
  const reads = vi.fn((key: string) => env.SESSION_STORE.get(key));
  const counts = new Map<string, number>();
  let attemptAllowance = Infinity;
  let actorAllowance = Infinity;
  const limit = vi.fn(async ({ key }: { key: string }) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return {
      success: count <= (key.startsWith("public:") ? attemptAllowance : actorAllowance),
    };
  });
  const bindings = {
    ...targetEnv,
    AUTH_JWKS_URI: "https://auth.splitch.test/.well-known/jwks.json",
    ...overrides,
    SESSION_STORE: {
      get: reads,
      put: env.SESSION_STORE.put.bind(env.SESSION_STORE),
      delete: env.SESSION_STORE.delete.bind(env.SESSION_STORE),
      list: env.SESSION_STORE.list.bind(env.SESSION_STORE),
    } as unknown as KVNamespace,
    CONTROL_PLANE_ACTOR_RATE_LIMITER: { limit } as RateLimit,
  };
  return {
    bindings,
    reads,
    limit,
    resetLimits(attempts = Infinity, actors = Infinity) {
      attemptAllowance = attempts;
      actorAllowance = actors;
      counts.clear();
      reads.mockClear();
      limit.mockClear();
    },
    async seed(
      grants: PersonalAccessTokenGrant[] = [
        { target: `app:${TENANT_A.appId}`, role: "admin", permissions: ["write"] },
      ],
      secret = SECRET,
      id = TOKEN_ID,
    ) {
      const row = await repo().personalAccessTokens.insert({
        id,
        userId: OWNER,
        name: "CLI bearer fixture",
        tokenHash: await sha256Hex(secret),
        grants: JSON.stringify(grants),
        expiresAt: null,
        createdAt: new Date().toISOString(),
      });
      await writePersonalAccessTokenCache(env.SESSION_STORE, row, row.tokenHash, false, Date.now());
    },
    call(method: string, path: string, body?: unknown, secret = SECRET, address = "192.0.2.10") {
      const request = new Request(`${AUDIENCE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          "cf-connecting-ip": address,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return worker.fetch(request, bindings, testCtx);
    },
  };
}
