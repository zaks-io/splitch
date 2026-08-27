import { applySchema, migrationStatements } from "@splitch/db/test-d1";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPanelBindings } from "./bindings";
import { refreshSession, SESSION_COOKIE_NAME, type StoredSession } from "./session";
import { tokenHash as hashOpaqueToken } from "./session-cookie";

// `org-members-functions.ts` imports the Cloudflare Workers runtime module at
// the top level for the exported `loadOrgMembers` server function; it is
// unavailable under plain vitest and unused by `loadOrgMembersForRequest`, the
// function under test here.
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { loadOrgMembersForRequest } = await import("./org-members-functions");

/**
 * `org-members.test.ts` proves the gates as functions. This proves the loader
 * actually calls them: delete `canViewOrgMembers(...)` from the loader and the
 * member case below asks the Control Plane for a roster it may not read.
 */
const TOKEN = `spl_${"b1c2d3".padEnd(64, "0")}`;
const NOW = "2026-08-07T08:00:00.000Z";

let mf: Miniflare;
let bindings: ControlPanelBindings;
let tokenHash: string;
let controlPlaneCalls: string[];

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: ["SESSION_STORE"],
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applySchema(d1, migrationStatements());
  await seedOrganization(d1, "org_000", "org-000");
  tokenHash = await hashOpaqueToken(TOKEN);
  controlPlaneCalls = [];
  bindings = {
    DB: d1,
    SESSION_STORE: (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace,
    WORKOS_API_KEY: "wk_test",
    WORKOS_CLIENT_ID: "client_test",
    AUTH_API_ORIGIN: "https://auth.example.test",
    EVALUATION_API_ORIGIN: "https://eval.example.test",
    // The signer refuses anything under 32 bytes, so the test secret is padded
    // to a real key length rather than a token word.
    CONTROL_PANEL_DELEGATION_SECRET: "delegation-secret".padEnd(32, "0"),
    CONTROL_PLANE_API: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        controlPlaneCalls.push(new Request(input, init).url);
        return Response.json({
          items: [
            {
              id: "user_cap",
              email: "owner@example.test",
              organizationId: "org_000",
              role: "owner",
              createdAt: NOW,
            },
          ],
          readLimit: 200,
          readTruncated: false,
          cursor: null,
        });
      },
    } as unknown as Fetcher,
  };
});

afterEach(async () => {
  await mf.dispose();
});

describe("loadOrgMembersForRequest", () => {
  it("reads the roster for an owner", async () => {
    await seedSession("owner");

    const result = await loadOrgMembersForRequest(bindings, requestWithSessionCookie(), "org-000");

    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);
    expect(result.view.members).toEqual({
      kind: "ready",
      items: [{ userId: "user_cap", email: "owner@example.test", role: "owner" }],
      readTruncated: false,
      readLimit: 200,
    });
    expect(controlPlaneCalls).toHaveLength(1);
  }, 20_000);

  it("forwards list truncation instead of presenting a partial roster as complete", async () => {
    bindings.CONTROL_PLANE_API = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        controlPlaneCalls.push(new Request(input, init).url);
        return Response.json({
          items: [
            {
              id: "user_cap",
              email: "owner@example.test",
              organizationId: "org_000",
              role: "owner",
              createdAt: NOW,
            },
          ],
          readLimit: 200,
          readTruncated: true,
          cursor: null,
        });
      },
    } as unknown as Fetcher;
    await seedSession("owner");

    const result = await loadOrgMembersForRequest(bindings, requestWithSessionCookie(), "org-000");

    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);
    expect(result.view.members).toMatchObject({
      kind: "ready",
      readTruncated: true,
      readLimit: 200,
    });
  }, 20_000);

  it("locks the roster for a member without asking the Control Plane for it", async () => {
    await seedSession("member");

    const result = await loadOrgMembersForRequest(bindings, requestWithSessionCookie(), "org-000");

    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);
    expect(result.view.members).toEqual({
      kind: "locked",
      message: "Only owners and admins can view Organization membership.",
    });
    expect(controlPlaneCalls).toEqual([]);
  }, 20_000);

  it("refuses an Organization the session does not carry", async () => {
    await seedSession("owner");

    const result = await loadOrgMembersForRequest(bindings, requestWithSessionCookie(), "org-999");

    expect(result.kind).toBe("forbidden");
    expect(controlPlaneCalls).toEqual([]);
  }, 20_000);

  it("reports a truncated snapshot instead of claiming the Organization is forbidden", async () => {
    await seedSession("owner", true);

    const result = await loadOrgMembersForRequest(bindings, requestWithSessionCookie(), "org-999");

    expect(result).toEqual({ kind: "truncated", limit: 1 });
    expect(controlPlaneCalls).toEqual([]);
  }, 20_000);
});

function requestWithSessionCookie(): Request {
  return new Request("https://control-panel.example.test/org-000/members", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` },
  });
}

async function seedSession(
  orgRole: "owner" | "admin" | "member",
  orgsTruncated = false,
): Promise<void> {
  const session: StoredSession = {
    version: 2,
    userId: "user_cap",
    workosSessionId: "session_cap",
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
    orgs: [
      {
        orgId: "org_000",
        orgSlug: "org-000",
        orgRole,
        isProvisional: false,
        demoExpiresAt: null,
        apps: [],
      },
    ],
    orgsTruncated,
  };
  await refreshSession(bindings.SESSION_STORE, tokenHash, session);
}

async function seedOrganization(d1: D1Database, id: string, slug: string): Promise<void> {
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES (?,?,?,'free',0,?,?)",
      )
      .bind(id, id, slug, NOW, NOW),
    d1
      .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(id, "user_cap", "owner", NOW),
  ]);
}
