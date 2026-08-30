import { applySchema, migrationStatements } from "@splitch/db/test-d1";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPanelMutationBindings } from "#lib/shared/bindings";
import {
  refreshSession,
  SESSION_COOKIE_NAME,
  sessionKey,
  type StoredSession,
} from "#lib/sessions/session";
import { tokenHash as hashOpaqueToken } from "#lib/sessions/session-cookie";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const { authorizeOrgMembersMutationForRequest } = await import(
  "#lib/organizations/control-plane-org-member-functions"
);

const TOKEN = `spl_${"c4d5e6".padEnd(64, "0")}`;
const NOW = Math.floor(Date.now() / 1000);

let mf: Miniflare;
let bindings: ControlPanelMutationBindings;
let controlPlaneCalls: number;

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: ["SESSION_STORE"],
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applySchema(d1, migrationStatements());
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES (?,?,?,'free',0,?,?)",
      )
      .bind(
        "org_allowed",
        "Allowed",
        "allowed",
        new Date().toISOString(),
        new Date().toISOString(),
      ),
    d1
      .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind("org_allowed", "user_owner", "owner", new Date().toISOString()),
  ]);
  controlPlaneCalls = 0;
  bindings = {
    DB: d1,
    SESSION_STORE: (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace,
    WORKOS_API_KEY: "wk_test",
    WORKOS_CLIENT_ID: "client_test",
    AUTH_API_ORIGIN: "https://auth.example.test",
    EVALUATION_API_ORIGIN: "https://eval.example.test",
    CONTROL_PANEL_DELEGATION_SECRET: "delegation-secret".padEnd(32, "0"),
    CONTROL_PLANE_API: {
      fetch: async () => {
        controlPlaneCalls += 1;
        return Response.json({
          items: [],
          readLimit: 200,
          readTruncated: false,
          cursor: null,
        });
      },
    } as unknown as Fetcher,
  };
  const tokenHash = await hashOpaqueToken(TOKEN);
  const session: StoredSession = {
    version: 2,
    userId: "user_owner",
    workosSessionId: "session_owner",
    expiresAt: NOW + 3_600,
    orgs: [
      {
        orgId: "org_allowed",
        orgSlug: "allowed",
        orgRole: "owner",
        isProvisional: false,
        demoExpiresAt: null,
        apps: [],
      },
    ],
  };
  await refreshSession(bindings.SESSION_STORE, tokenHash, session);
});

afterEach(async () => mf.dispose());

describe("Organization member mutation session gate", () => {
  it("returns forbidden before creating a client for an Organization absent from the session", async () => {
    const result = await authorizeOrgMembersMutationForRequest(
      bindings,
      requestWithSessionCookie(),
      "org_other",
    );

    expect(result).toMatchObject({
      ok: false,
      result: { status: 403, error: { code: "FORBIDDEN" } },
    });
    expect(controlPlaneCalls).toBe(0);
  });

  it("creates the delegated client for an Organization carried by the session", async () => {
    const result = await authorizeOrgMembersMutationForRequest(
      bindings,
      requestWithSessionCookie(),
      "org_allowed",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an authorized client");
    await result.members.list({ orgId: "org_allowed" });
    expect(controlPlaneCalls).toBe(1);
  });

  it("rehydrates a legacy session before checking Organization membership", async () => {
    const legacy: StoredSession = {
      version: 1,
      userId: "user_owner",
      workosSessionId: "session_owner",
      expiresAt: NOW + 3_600,
      orgs: [],
    };
    const tokenHash = await hashOpaqueToken(TOKEN);
    await bindings.SESSION_STORE.put(sessionKey(tokenHash), JSON.stringify(legacy), {
      expirationTtl: 3_600,
    });

    const result = await authorizeOrgMembersMutationForRequest(
      bindings,
      requestWithSessionCookie(),
      "org_allowed",
    );

    expect(result.ok).toBe(true);
  });

  it("explains a truncated session instead of claiming the Organization is forbidden", async () => {
    const tokenHash = await hashOpaqueToken(TOKEN);
    const session: StoredSession = {
      version: 2,
      userId: "user_owner",
      workosSessionId: "session_owner",
      expiresAt: NOW + 3_600,
      orgs: [],
      orgsTruncated: true,
    };
    await refreshSession(bindings.SESSION_STORE, tokenHash, session);

    const result = await authorizeOrgMembersMutationForRequest(
      bindings,
      requestWithSessionCookie(),
      "org_outside_snapshot",
    );

    expect(result).toMatchObject({
      ok: false,
      result: {
        status: 403,
        error: {
          code: "FORBIDDEN",
          message: expect.stringContaining("this list is cut short"),
        },
      },
    });
    expect(controlPlaneCalls).toBe(0);
  });
});

function requestWithSessionCookie(): Request {
  return new Request("https://control-panel.example.test/allowed/members", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` },
  });
}
