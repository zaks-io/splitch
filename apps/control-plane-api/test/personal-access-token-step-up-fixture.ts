import {
  type PersonalAccessToken,
  type PersonalAccessTokenGrant,
  personalAccessTokenCacheKey,
} from "@splitch/contracts";
import { createRepository, type Repository } from "@splitch/db";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { sha256Hex } from "../src/credential-cache";
import { makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import { makeTestApp } from "../src/test-app-fixture";
import { AUDIENCE, ISSUER } from "../src/test-constants";
import {
  seedOrgApp,
  seedOrgMember,
  seedAppMember,
  resetOrganizationGraph,
} from "../src/test-seeds";
import { makeTokenMembershipAccess } from "../src/token-membership";
import { makePoolBindings } from "./pool-bindings";

export const USER = "user_step_up";
export const APP = "app_step_up";
export const ORG = "org_step_up";
export const OTHER_APP = "app_step_up_other";
export const readGrant: PersonalAccessTokenGrant = {
  target: `app:${APP}`,
  role: "member",
  permissions: [],
};
export const broadGrant: PersonalAccessTokenGrant = {
  target: "all",
  role: "owner",
  permissions: ["write"],
};

export async function stepUpFixture() {
  const bindings = await makePoolBindings();
  await resetOrganizationGraph(bindings.d1);
  const repo = createRepository(bindings.d1);
  for (const [appId, orgId] of [
    [APP, ORG],
    [OTHER_APP, "org_step_up_other"],
  ]) {
    await seedOrgApp(bindings.d1, {
      orgId: orgId as string,
      appId: appId as string,
      orgName: "Step up",
      appName: "Step up",
      appKey: appId as string,
    });
    await seedOrgMember(bindings.d1, { orgId: orgId as string, userId: USER, role: "owner" });
    await seedAppMember(bindings.d1, { appId: appId as string, userId: USER, role: "owner" });
  }
  const signer = await makeFixtureSigner();
  let nowMs = Date.now();
  const puts: { key: string; value: string }[] = [];
  let failPut: number | undefined;
  const store = {
    put: async (key: string, value: string, options: KVNamespacePutOptions) => {
      puts.push({ key, value });
      await bindings.kv.put(key, value, options);
      if (puts.length === failPut) throw new Error("injected after KV write");
    },
  } as unknown as KVNamespace;
  const events: unknown[] = [];
  const appFor = (actualRepo: Repository = repo) =>
    makeTestApp({
      repo: actualRepo,
      personalAccessTokenStore: store,
      nowIso: () => new Date(nowMs).toISOString(),
      observability: { onRequest: (e) => events.push(e), onError: (e) => events.push(e) },
      authResolver: makeControlPlaneAuthResolver({
        verifier: makeJwksVerifier({
          issuer: ISSUER,
          controlPlaneAudience: AUDIENCE,
          fetchJwks: async () => signer.jwks,
        }),
        sessions: makeSessionStore(bindings.kv),
        membershipAccess: makeTokenMembershipAccess(repo),
        now: () => nowMs,
      }),
    });
  let app = appFor();
  const jwt = (claims: Record<string, unknown> = {}) =>
    signer.sign({
      sub: USER,
      iss: ISSUER,
      aud: AUDIENCE,
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + 3600,
      scopes: [`app:${APP}:member`],
      auth_door: "device_flow",
      ...claims,
    });
  const approval = (claims: Record<string, unknown> = {}) =>
    jwt({
      authorization: "pat-management",
      scopes: [],
      jti: crypto.randomUUID(),
      exp: Math.floor(nowMs / 1000) + 300,
      ...claims,
    });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    options: { approval?: string; claims?: Record<string, unknown>; bearer?: string } = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${options.bearer ?? (await jwt(options.claims))}`,
        ...(options.approval ? { "Splitch-PAT-Authorization": options.approval } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const seed = async (
    grants: PersonalAccessTokenGrant[] = [broadGrant],
    expiresAt: string | null = null,
  ) => {
    const secret = `spl_pat_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    const hash = await sha256Hex(secret);
    const row = await repo.personalAccessTokens.insert({
      id: `pat_${crypto.randomUUID().replaceAll("-", "")}`,
      userId: USER,
      name: "seeded",
      grants: JSON.stringify(grants),
      expiresAt,
      tokenHash: hash,
      createdAt: new Date(nowMs).toISOString(),
    });
    await bindings.kv.put(
      personalAccessTokenCacheKey(hash),
      JSON.stringify({
        version: 1,
        tokenId: row.id,
        userId: USER,
        createdAt: row.createdAt,
        expiresAt,
        revoked: false,
      }),
    );
    return { row, secret };
  };
  return {
    bindings,
    repo,
    signer,
    puts,
    events,
    jwt,
    approval,
    call,
    seed,
    app: () => app,
    rebuild: (actualRepo: Repository) => {
      app = appFor(actualRepo);
    },
    setFailure: (callNumber: number) => {
      failPut = callNumber;
    },
    now: () => nowMs,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    created: (response: Response) =>
      response.json() as Promise<{ token: PersonalAccessToken; secret: string }>,
  };
}
