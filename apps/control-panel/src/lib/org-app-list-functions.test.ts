import { applySchema, migrationStatements } from "@splitch/db/test-d1";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPanelBindings } from "./bindings";
import { markPendingResync, readPendingResync } from "./pending-resync";
import { refreshSession, SESSION_COOKIE_NAME, type StoredSession } from "./session";
import { tokenHash as hashOpaqueToken } from "./session-cookie";

// `org-app-list-functions.ts` imports the Cloudflare Workers runtime module
// at the top level for the exported `loadOrgAppList` server function; it is
// unavailable under plain vitest (no wrangler/workerd runtime), and unused
// by `loadOrgAppListForRequest`, the function under test here.
vi.mock("cloudflare:workers", () => ({ env: {} }));
const createControlPanelFlagsClientMock = vi.fn();

vi.mock("./control-plane-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-plane-apps")>()),
  createControlPanelFlagsClient: (...args: unknown[]) => createControlPanelFlagsClientMock(...args),
}));

const { loadOrgAppListForRequest } = await import("./org-app-list-functions");

/**
 * The loader-level proof for SPL-203's self-heal (round 2, Blocker 2): a
 * reload only re-attempts a failed App resync because `loadOrgAppList`
 * actually calls `retryPendingResync` when a marker is pending
 * (`org-app-list-functions.ts:45-51`). `retryPendingResync` itself is
 * covered in isolation (`session-resync.test.ts`), but nothing proved a
 * loader calls it — deleting that wiring left the full suite green.
 *
 * `loadOrgAppListForRequest` takes `bindings`/`request` as explicit
 * parameters rather than reading `workerEnv`/`getRequest()` internally, so
 * it can run here against real Miniflare D1 + KV without the framework's
 * build-time transform (which plain vitest does not apply, and which the
 * exported `loadOrgAppList` server function needs to behave correctly).
 */

const TOKEN = `spl_${"a0b1c2".padEnd(64, "0")}`;
let tokenHash: string;

let mf: Miniflare;
let bindings: ControlPanelBindings;

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: ["SESSION_STORE"],
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applySchema(d1, migrationStatements());
  tokenHash = await hashOpaqueToken(TOKEN);
  bindings = {
    DB: d1,
    SESSION_STORE: (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace,
    WORKOS_API_KEY: "wk_test",
    WORKOS_CLIENT_ID: "client_test",
    AUTH_API_ORIGIN: "https://auth.example.test",
    EVALUATION_API_ORIGIN: "https://eval.example.test",
  };
  createControlPanelFlagsClientMock.mockReset();
});

afterEach(async () => {
  await mf.dispose();
});

function requestWithSessionCookie(): Request {
  return new Request("https://control-panel.example.test/checkout", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` },
  });
}

describe("loadOrgAppListForRequest", () => {
  it("re-attempts a pending App resync on load, returning the previously-missing App and clearing the marker", async () => {
    await seedOrganization(bindings.DB, "org_000", "org-000");
    await seedApp(bindings.DB, "app_000", "org_000", "checkout-api");

    // The stale principal: the Organization exists, but the App create it
    // predates is missing, exactly as a failed post-create resync would
    // leave it.
    const stale: StoredSession = {
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
          apps: [],
        },
      ],
    };
    await refreshSession(bindings.SESSION_STORE, tokenHash, stale);
    await markPendingResync(bindings.SESSION_STORE, tokenHash, {
      resource: "app",
      orgId: "org_000",
      slug: "checkout-api",
      reason: "unknown App role in session materialization",
      remedy: "retry",
    });

    const result = await loadOrgAppListForRequest(bindings, requestWithSessionCookie(), "org-000");

    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);
    // This is the mutation target: comment out the retry call inside
    // `loadOrgAppListForRequest` (leave only `const session = rehydrated`)
    // and this assertion fails, because the App the User created is still
    // absent from the rendered list.
    expect(result.view.apps.map((app) => app.appSlug)).toContain("checkout-api");
    // "Reload to check again" is only honest if the marker actually clears,
    // in the notice this same load renders...
    expect(result.view.pendingAppResync).toBeNull();
    // ...and durably, so a second load does not resurface it.
    expect(await readPendingResync(bindings.SESSION_STORE, tokenHash, "app")).toBeNull();
  }, 20_000);

  it("leaves a pending App resync notice in place when the App belongs to a different Organization", async () => {
    await seedOrganization(bindings.DB, "org_000", "org-000");
    await seedOrganization(bindings.DB, "org_001", "org-001");

    const stale: StoredSession = {
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
          apps: [],
        },
        {
          orgId: "org_001",
          orgSlug: "org-001",
          orgRole: "owner",
          isProvisional: false,
          demoExpiresAt: null,
          apps: [],
        },
      ],
    };
    await refreshSession(bindings.SESSION_STORE, tokenHash, stale);
    await markPendingResync(bindings.SESSION_STORE, tokenHash, {
      resource: "app",
      orgId: "org_001",
      slug: "other-org-app",
      reason: "boom",
      remedy: "retry",
    });

    const result = await loadOrgAppListForRequest(bindings, requestWithSessionCookie(), "org-000");

    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);
    // A pending marker for a different Organization must never surface here,
    // and reading org-000 must not touch org-001's marker.
    expect(result.view.pendingAppResync).toBeNull();
    expect(await readPendingResync(bindings.SESSION_STORE, tokenHash, "app")).not.toBeNull();
  }, 20_000);

  it("reads Flag count through a delegation Environment and carries the Organization visit hint", async () => {
    await seedOrganization(bindings.DB, "org_000", "org-000");
    await seedApp(bindings.DB, "app_000", "org_000", "checkout-api");
    await seedEnvironment(bindings.DB, "env_000", "app_000", "dev");
    await refreshSession(bindings.SESSION_STORE, tokenHash, {
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
    });
    const controlPlaneUnavailable = {
      fetch: async () => new Response(null, { status: 503 }),
    } as unknown as Fetcher;
    const flagsBindings: ControlPanelBindings = {
      ...bindings,
      CONTROL_PLANE_API: controlPlaneUnavailable,
      CONTROL_PANEL_DELEGATION_SECRET: "delegation-secret",
    };
    createControlPanelFlagsClientMock.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        ok: true,
        data: { items: [{ id: "flag_1" }], readTruncated: true, readLimit: 1 },
      }),
    });
    const hint = encodeURIComponent(
      JSON.stringify({
        v: 1,
        orgs: {
          org_000: {
            path: "/org-000/checkout-api/dev/flags",
            appSlug: "checkout-api",
            env: "dev",
            section: "flags",
            at: 1_000,
          },
        },
      }),
    );
    const request = new Request("https://control-panel.example.test/org-000", {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${TOKEN}; __last_visited=${hint}`,
      },
    });

    const result = await loadOrgAppListForRequest(flagsBindings, request, "org-000");

    if (result.kind !== "ok") throw new Error(`expected kind "ok", got "${result.kind}"`);
    expect(createControlPanelFlagsClientMock).toHaveBeenCalledWith(
      controlPlaneUnavailable,
      expect.objectContaining({ actorId: expect.any(String) }),
      "env_000",
      "delegation-secret",
    );
    expect(result.view.apps[0]?.flags).toEqual({ kind: "ready", count: 1, truncated: true });
    expect(result.view.lastVisited?.path).toBe("/org-000/checkout-api/dev/flags");
    expect(result.view.now).toBeTypeOf("number");

    createControlPanelFlagsClientMock.mockReturnValueOnce({
      list: vi.fn().mockRejectedValue(new Error("catalog transport failed")),
    });
    const failed = await loadOrgAppListForRequest(flagsBindings, request, "org-000");
    if (failed.kind !== "ok") throw new Error(`expected kind "ok", got "${failed.kind}"`);
    expect(failed.view.apps[0]?.flags).toEqual({
      kind: "unavailable",
      message: "catalog transport failed",
    });
  }, 20_000);
});

async function seedOrganization(d1: D1Database, id: string, slug: string): Promise<void> {
  const now = "2026-07-29T08:00:00.000Z";
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES (?,?,?,'free',0,?,?)",
      )
      .bind(id, id, slug, now, now),
    d1
      .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(id, "user_cap", "owner", now),
  ]);
}

async function seedApp(d1: D1Database, id: string, orgId: string, key: string): Promise<void> {
  const now = "2026-07-29T08:00:00.000Z";
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(id, orgId, id, key, now, now, "user_cap"),
    d1
      .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
      .bind(id, "user_cap", "owner", now),
  ]);
}

async function seedEnvironment(
  d1: D1Database,
  id: string,
  appId: string,
  key: string,
): Promise<void> {
  const now = "2026-07-29T08:00:00.000Z";
  const policy = JSON.stringify({
    variantAvailability: "allow",
    targetingRolloutValue: "allow",
    enabledState: "allow",
    startExperimentRun: "allow",
  });
  await d1
    .prepare(
      "INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(id, appId, key, "Development", policy, now, now, "user_cap")
    .run();
}
