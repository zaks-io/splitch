import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPanelMutationBindings } from "./bindings";
import { refreshSession, SESSION_COOKIE_NAME, type StoredSession } from "./session";
import { tokenHash as hashOpaqueToken } from "./session-cookie";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const { authorizeOrgMembersMutationForRequest } = await import(
  "./control-plane-org-member-functions"
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
  controlPlaneCalls = 0;
  bindings = {
    DB: (await mf.getD1Database("DB")) as unknown as D1Database,
    SESSION_STORE: (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace,
    WORKOS_API_KEY: "wk_test",
    WORKOS_CLIENT_ID: "client_test",
    AUTH_API_ORIGIN: "https://auth.example.test",
    EVALUATION_API_ORIGIN: "https://eval.example.test",
    CONTROL_PANEL_DELEGATION_SECRET: "delegation-secret".padEnd(32, "0"),
    CONTROL_PLANE_API: {
      fetch: async () => {
        controlPlaneCalls += 1;
        return Response.json({ items: [] });
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
});

function requestWithSessionCookie(): Request {
  return new Request("https://control-panel.example.test/allowed/members", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` },
  });
}
