import { applySchema, migrationStatements } from "@splitch/db/test-d1";
import { CONTROL_PANEL_DELEGATION_HEADER } from "@splitch/control-plane-sdk/control-panel-identity";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPanelBindings } from "./bindings";
import { refreshSession, SESSION_COOKIE_NAME, type StoredSession } from "./session";
import { tokenHash as hashOpaqueToken } from "./session-cookie";

// The Workers runtime module backs the exported server function only; the
// `*ForRequest` loader under test takes its bindings as parameters.
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { loadOrgBillingForRequest } = await import("./org-billing-functions");

const TOKEN = `spl_${"b1c2d3".padEnd(64, "0")}`;
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";

let mf: Miniflare;
let bindings: ControlPanelBindings;
let requests: Request[];

const USAGE = {
  organizationId: "org_000",
  period: { month: "2026-08", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-09-01T00:00:00Z" },
  state: "populated",
  evaluations: 100,
  breakdown: {
    byApp: [{ appId: "app_000", evaluations: 100 }],
    byEnvironment: [{ environmentId: "env_000", evaluations: 100 }],
    byFlag: [{ flagKey: "checkout-redesign", evaluations: 100 }],
    bySdkRuntime: [{ sdkRuntime: "node", evaluations: 100 }],
    byBatch: [{ mode: "single", evaluations: 100 }],
    bySource: [{ source: "remote", evaluations: 100 }],
    byExposure: [{ exposure: "bearing", evaluations: 40 }],
  },
};

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: ["SESSION_STORE"],
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applySchema(d1, migrationStatements());
  requests = [];
  bindings = {
    DB: d1,
    SESSION_STORE: (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace,
    WORKOS_API_KEY: "wk_test",
    WORKOS_CLIENT_ID: "client_test",
    AUTH_API_ORIGIN: "https://auth.example.test",
    EVALUATION_API_ORIGIN: "https://eval.example.test",
    CONTROL_PANEL_DELEGATION_SECRET: DELEGATION_SECRET,
    CONTROL_PLANE_API: {
      async fetch(request: Request) {
        requests.push(request);
        return new Response(JSON.stringify(USAGE), {
          headers: { "content-type": "application/json" },
        });
      },
    } as unknown as Fetcher,
  };
});

afterEach(async () => {
  await mf.dispose();
});

describe("loadOrgBillingForRequest", () => {
  it("reads this Organization's usage over a signed delegation and labels it from D1", async () => {
    await seed(bindings.DB);
    await seedSession();

    const result = await loadOrgBillingForRequest(bindings, requestWithSession(), "org-000");
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);

    // The binding call is the same signed one every other Panel read uses, and
    // it names the Organization it reads.
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/orgs/org_000/usage");
    expect(requests[0]?.headers.get(CONTROL_PANEL_DELEGATION_HEADER)).toBeTruthy();

    expect(result.view.plan).toBe("free");
    expect(result.view.hasBillingAccount).toBe(false);
    if (result.view.usage.kind !== "ready") throw new Error("expected a usage read");
    expect(result.view.usage.evaluations).toBe(100);

    const labels = result.view.usage.dimensions.flatMap((dimension) =>
      dimension.rows.map((row) => row.label),
    );
    expect(labels).toContain("Checkout API");
    expect(labels).toContain("Checkout API · Production");
    expect(labels.join(" ")).not.toContain("app_000");
  });

  it("refuses an Organization this session is not a member of, without asking for its usage", async () => {
    await seed(bindings.DB);
    await seedSession();

    // A tenant boundary, not a rendering case: the usage read is never issued.
    expect(await loadOrgBillingForRequest(bindings, requestWithSession(), "org-other")).toEqual({
      kind: "forbidden",
    });
    expect(requests).toEqual([]);
  });

  it("has no billing screen for a request carrying no session", async () => {
    await seed(bindings.DB);

    const anonymous = new Request("https://control-panel.example.test/org-000/billing");
    expect(await loadOrgBillingForRequest(bindings, anonymous, "org-000")).toEqual({
      kind: "unauthenticated",
    });
    expect(requests).toEqual([]);
  });
});

function requestWithSession(): Request {
  return new Request("https://control-panel.example.test/org-000/billing", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` },
  });
}

async function seedSession(): Promise<void> {
  const session: StoredSession = {
    version: 2,
    userId: "user_cap",
    workosSessionId: "session_cap",
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
    orgs: [
      {
        orgId: "org_000",
        orgSlug: "org-000",
        orgRole: "owner",
        isProvisional: false,
        demoExpiresAt: null,
        apps: [{ appId: "app_000", appSlug: "checkout-api", role: "owner" }],
      },
    ],
  };
  await refreshSession(bindings.SESSION_STORE, await hashOpaqueToken(TOKEN), session);
}

async function seed(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      )
      .bind("org_000", "Org 000", "org-000", "free", now, now),
    db
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("app_000", "org_000", "Checkout API", "checkout-api", now, now, "user_cap"),
    db
      .prepare(
        "INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "env_000",
        "app_000",
        "prod",
        "Production",
        '{"variantAvailability":"allow","targetingRolloutValue":"allow","enabledState":"allow","startExperimentRun":"allow"}',
        now,
        now,
        "user_cap",
      ),
    db
      .prepare(
        "INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind("org_000", "user_cap", "owner", now),
    db
      .prepare(
        "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind("app_000", "user_cap", "owner", now),
  ]);
}
