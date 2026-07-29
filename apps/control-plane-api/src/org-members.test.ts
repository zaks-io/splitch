import type { ErrorResponse } from "@splitch/contracts";
import { deriveMcpTools, getRoute } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import { hc } from "hono/client";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { createApp } from "./app";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { makeSessionStore } from "./session-store";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";
import { seedOrgApp, seedOrgMember } from "./test-seeds";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 1, 12, 0, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();
const PRIMARY = {
  orgId: "org_ledger_128d",
  orgName: "Ledger",
  appId: "app_ledger_128d",
  appName: "Ledger App",
  appKey: "ledger",
};
const SOLO = {
  orgId: "org_solo_884f",
  orgName: "Solo",
  appId: "app_solo_884f",
  appName: "Solo App",
  appKey: "solo",
};
const OWNER = "user_owner_d3a1";
const ADMIN = "user_admin_948f";
const MEMBER = "user_member_438c";
const NEW_MEMBER = "user_new_529e";
const SOLO_OWNER = "user_solo_owner_0f8a";

const PROFILE_EMAILS = new Map([
  [OWNER, "owner@example.test"],
  [ADMIN, "admin@example.test"],
  [MEMBER, "member@example.test"],
  [NEW_MEMBER, "new@example.test"],
  [SOLO_OWNER, "solo@example.test"],
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

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, PRIMARY);
  await seedOrgApp(bindings.d1, SOLO);
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: OWNER, role: "owner" });
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: ADMIN, role: "admin" });
  await seedOrgMember(bindings.d1, { orgId: PRIMARY.orgId, userId: MEMBER, role: "member" });
  await seedOrgMember(bindings.d1, { orgId: SOLO.orgId, userId: SOLO_OWNER, role: "owner" });

  const signer = await makeFixtureSigner();
  const verifier = makeJwksVerifier({
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  const app = createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier,
      sessions: makeSessionStore(bindings.kv),
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo: createRepository(bindings.d1),
    memberProfileResolver: ({ userId }) => {
      const email = PROFILE_EMAILS.get(userId);
      return email ? { email } : null;
    },
    nowIso: () => NOW_ISO,
  });

  h = { app, signer, bindings };
});

afterEach(async () => h.bindings.dispose());

async function bodyOf(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}

function token(userId: string, orgId: string, role: "owner" | "admin" | "member"): Promise<string> {
  return h.signer.sign({
    sub: userId,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`org:${orgId}:${role}`],
  });
}

function client(jwt: string) {
  const fetchImpl: typeof fetch = async (input, init) => h.app.fetch(new Request(input, init));
  return hc<typeof h.app>(AUDIENCE, {
    fetch: fetchImpl,
    headers: { authorization: `Bearer ${jwt}` },
  }) as unknown as OrgRouteClient;
}

function orgRoute(api: OrgRouteClient): OrgScopedClient {
  const route = api.orgs[":orgId"];
  if (!route) throw new Error("hc client did not expose /orgs/:orgId");
  return route;
}

function memberRoute(api: OrgRouteClient): MemberCollectionClient {
  return orgRoute(api).members;
}

function memberResourceRoute(api: OrgRouteClient): MemberResourceClient {
  const route = memberRoute(api)[":userId"];
  if (!route) throw new Error("hc client did not expose /orgs/:orgId/members/:userId");
  return route;
}

describe("control-plane org/member endpoints", () => {
  it("round-trips Org patch and member CRUD through the mounted Worker", async () => {
    const ownerJwt = await token(OWNER, PRIMARY.orgId, "owner");
    const api = client(ownerJwt);

    const orgs = orgRoute(api);
    const members = memberRoute(api);
    const memberResource = memberResourceRoute(api);

    const updatedOrg = await orgs.$patch({
      param: { orgId: PRIMARY.orgId },
      json: { name: "Ledger Renamed", plan: "pro" },
    });
    expect(updatedOrg.status).toBe(200);
    expect(await updatedOrg.json()).toMatchObject({
      id: PRIMARY.orgId,
      name: "Ledger Renamed",
      plan: "pro",
      updatedAt: NOW_ISO,
    });

    const added = await members.$post({
      param: { orgId: PRIMARY.orgId },
      json: { userId: NEW_MEMBER, role: "admin" },
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({
      id: NEW_MEMBER,
      email: "new@example.test",
      organizationId: PRIMARY.orgId,
      role: "admin",
    });

    const changed = await memberResource.$patch({
      param: { orgId: PRIMARY.orgId, userId: NEW_MEMBER },
      json: { role: "member" },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ id: NEW_MEMBER, role: "member" });

    const listed = await members.$get({
      param: { orgId: PRIMARY.orgId },
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { items: unknown[] };
    expect(listBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: OWNER, email: "owner@example.test", role: "owner" }),
        expect.objectContaining({ id: NEW_MEMBER, email: "new@example.test", role: "member" }),
      ]),
    );

    const removed = await memberResource.$delete({
      param: { orgId: PRIMARY.orgId, userId: NEW_MEMBER },
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
  });

  it("403s a member-role token attempting Org patch or member add", async () => {
    const memberJwt = await token(MEMBER, PRIMARY.orgId, "member");
    const api = client(memberJwt);

    const patchOrg = await orgRoute(api).$patch({
      param: { orgId: PRIMARY.orgId },
      json: { name: "Nope" },
    });
    expect(patchOrg.status).toBe(403);
    expect((await bodyOf(patchOrg)).code).toBe("FORBIDDEN");

    const addMember = await memberRoute(api).$post({
      param: { orgId: PRIMARY.orgId },
      json: { userId: NEW_MEMBER, role: "member" },
    });
    expect(addMember.status).toBe(403);
    expect((await bodyOf(addMember)).code).toBe("FORBIDDEN");
  });

  it("403s an admin-role token granting the owner role (owner grants are owner-only)", async () => {
    const adminJwt = await token(ADMIN, PRIMARY.orgId, "admin");
    const res = await memberRoute(client(adminJwt)).$post({
      param: { orgId: PRIMARY.orgId },
      json: { userId: NEW_MEMBER, role: "owner" },
    });

    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FORBIDDEN");
  });

  it("lets an owner-role token grant the owner role", async () => {
    const ownerJwt = await token(OWNER, PRIMARY.orgId, "owner");
    const res = await memberRoute(client(ownerJwt)).$post({
      param: { orgId: PRIMARY.orgId },
      json: { userId: NEW_MEMBER, role: "owner" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: NEW_MEMBER, role: "owner" });
  });

  it("does not let member add change an existing member role", async () => {
    const adminJwt = await token(ADMIN, PRIMARY.orgId, "admin");
    const res = await memberRoute(client(adminJwt)).$post({
      param: { orgId: PRIMARY.orgId },
      json: { userId: OWNER, role: "member" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: OWNER, role: "owner" });
  });

  it("409s LAST_OWNER_REQUIRED when removing or demoting the last owner", async () => {
    const ownerJwt = await token(SOLO_OWNER, SOLO.orgId, "owner");
    const resource = memberResourceRoute(client(ownerJwt));

    const demote = await resource.$patch({
      param: { orgId: SOLO.orgId, userId: SOLO_OWNER },
      json: { role: "member" },
    });
    expect(demote.status).toBe(409);
    expect((await bodyOf(demote)).code).toBe("LAST_OWNER_REQUIRED");

    const res = await resource.$delete({
      param: { orgId: SOLO.orgId, userId: SOLO_OWNER },
    });

    expect(res.status).toBe(409);
    const err = await bodyOf(res);
    expect(err.code).toBe("LAST_OWNER_REQUIRED");
    if (err.code === "LAST_OWNER_REQUIRED") {
      expect(err.details.orgId).toBe(SOLO.orgId);
    }
  });

  it("derives matching MCP tools for the mounted Organization operations", async () => {
    const ownerJwt = await token(OWNER, PRIMARY.orgId, "owner");
    const getOrg = await orgRoute(client(ownerJwt)).$get({
      param: { orgId: PRIMARY.orgId },
    });
    expect(getOrg.status).toBe(200);

    const expected = [
      "organizations_get",
      "organizations_update",
      "organization_members_list",
      "organization_members_add",
      "organization_members_update",
      "organization_members_remove",
    ] as const;
    const tools = deriveMcpTools();

    for (const operationId of expected) {
      const route = getRoute(operationId);
      const tool = tools.find((candidate) => candidate.name === operationId);
      expect(tool).toBeDefined();
      expect(route).toBeDefined();
      expect(tool?.outputSchema).toBe(route?.output);
    }
  });
});
