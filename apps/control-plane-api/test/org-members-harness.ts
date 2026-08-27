import type { ErrorResponse } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { hc } from "hono/client";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings } from "./pool-bindings";

export const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 1, 12, 0, 0);
export const NOW_ISO = new Date(NOW_MS).toISOString();
export const PRIMARY = {
  orgId: "org_ledger_128d",
  orgName: "Ledger",
  appId: "app_ledger_128d",
  appName: "Ledger App",
  appKey: "ledger",
};
export const SOLO = {
  orgId: "org_solo_884f",
  orgName: "Solo",
  appId: "app_solo_884f",
  appName: "Solo App",
  appKey: "solo",
};
export const OWNER = "user_owner_d3a1";
export const ADMIN = "user_admin_948f";
export const MEMBER = "user_member_438c";
export const NEW_MEMBER = "user_new_529e";
export const PROFILELESS_MEMBER = "user_profileless_71c2";
export const SOLO_OWNER = "user_solo_owner_0f8a";
export const SOLO_ADMIN = "user_solo_admin_662e";
export const UNKNOWN_USER = "user_never_seeded_a71f";

const PROFILE_EMAILS = new Map([
  [OWNER, "owner@example.test"],
  [ADMIN, "admin@example.test"],
  [MEMBER, "member@example.test"],
  [NEW_MEMBER, "new@example.test"],
  [SOLO_OWNER, "solo@example.test"],
  [SOLO_ADMIN, "solo-admin@example.test"],
]);

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

interface OrgRouteClient {
  orgs: { [orgParam: `:${string}`]: OrgScopedClient };
}

interface OrgScopedClient {
  $get(args: { param: { orgId: string } }): Promise<Response>;
  $patch(args: { param: { orgId: string }; json: Record<string, unknown> }): Promise<Response>;
  members: MemberCollectionClient;
}

interface MemberCollectionClient {
  $get(args: { param: { orgId: string } }): Promise<Response>;
  $post(args: {
    param: { orgId: string };
    json: { userId: string; role: "owner" | "admin" | "member" };
  }): Promise<Response>;
  [userParam: `:${string}`]: MemberResourceClient;
}

interface MemberResourceClient {
  $patch(args: {
    param: { orgId: string; userId: string };
    json: { role: "owner" | "admin" | "member" };
  }): Promise<Response>;
  $delete(args: { param: { orgId: string; userId: string } }): Promise<Response>;
}

const allowLimiter: RateLimiter = () => ({ limited: false });
const nowSeconds = () => Math.floor(NOW_MS / 1000);

let h: Harness;

/**
 * Seed the two Organizations the suite reads from.
 *
 * Runs once per file rather than per test: the Workers pool isolates storage per
 * FILE, not per test (isolatedStorage was dropped in the Vitest 4 migration,
 * workers-sdk#12889), so re-inserting these would trip the slug unique index.
 */
export async function seedOrgs(): Promise<void> {
  const bindings = await makePoolBindings();
  await seedOrgApp(bindings.d1, PRIMARY);
  await seedOrgApp(bindings.d1, SOLO);
}

/**
 * Rebuild the membership roster and mount a fresh Worker.
 *
 * The memberships are rebuilt per test because this suite mutates them (it
 * renames the Org, adds and removes members, and grants roles) and every test
 * expects the same starting roster.
 */
export async function setup(): Promise<void> {
  const bindings = await makePoolBindings();
  await bindings.d1.prepare("DELETE FROM org_memberships").run();
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: OWNER, role: "owner" });
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: ADMIN, role: "admin" });
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: MEMBER, role: "member" });
  await seedOrgMember(bindings.d1, {
    orgId: PRIMARY.orgId,
    userId: PROFILELESS_MEMBER,
    role: "member",
  });
  await seedOrgMember(bindings.d1, { orgId: SOLO.orgId, userId: SOLO_OWNER, role: "owner" });
  await seedOrgMember(bindings.d1, { orgId: SOLO.orgId, userId: SOLO_ADMIN, role: "admin" });

  const signer = await makeFixtureSigner();
  const verifier = makeJwksVerifier({
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  const app = createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier,
      sessions: makeSessionStore(bindings.kv),
      membershipAccess: { authorize: async () => true },
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
    memberProfileResolver: ({ userId, request }) => {
      if (request.headers.get("x-test-profile-failure-user") === userId) {
        throw new Error("profile store unavailable");
      }
      const email = PROFILE_EMAILS.get(userId);
      return email ? { email } : null;
    },
    nowIso: () => NOW_ISO,
  });

  h = { app, signer, bindings };
}

export async function teardown(): Promise<void> {
  await h.bindings.dispose();
}

export async function bodyOf(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

export function token(
  userId: string,
  orgId: string,
  role: "owner" | "admin" | "member",
): Promise<string> {
  return h.signer.sign({
    sub: userId,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`org:${orgId}:${role}`],
  });
}

export function client(jwt: string, headers: Record<string, string> = {}) {
  const fetchImpl: typeof fetch = async (input, init) => h.app.fetch(new Request(input, init));
  return hc<typeof h.app>(AUDIENCE, {
    fetch: fetchImpl,
    headers: { authorization: `Bearer ${jwt}`, ...headers },
  }) as unknown as OrgRouteClient;
}

export function orgRoute(api: OrgRouteClient): OrgScopedClient {
  const route = api.orgs[":orgId"];
  if (!route) throw new Error("hc client did not expose /orgs/:orgId");
  return route;
}

export function memberRoute(api: OrgRouteClient): MemberCollectionClient {
  return orgRoute(api).members;
}

export function memberResourceRoute(api: OrgRouteClient): MemberResourceClient {
  const route = memberRoute(api)[":userId"];
  if (!route) throw new Error("hc client did not expose /orgs/:orgId/members/:userId");
  return route;
}
