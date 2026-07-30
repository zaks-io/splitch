import { applySchema, migrationStatements } from "@splitch/db/test-d1";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPanelBindings } from "./bindings";
import { markPendingResync, readPendingResync } from "./pending-resync";
import { refreshSession, SESSION_COOKIE_NAME, type StoredSession } from "./session";
import { tokenHash as hashOpaqueToken } from "./session-cookie";

// `session-functions.ts` imports the Cloudflare Workers runtime module at
// the top level for the exported `loadCurrentSession` server function; it is
// unavailable under plain vitest (no wrangler/workerd runtime), and unused
// by `loadCurrentSessionForRequest`, the function under test here.
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { loadCurrentSessionForRequest } = await import("./session-functions");

/**
 * The loader-level proof for SPL-203's self-heal (round 2, Blocker 2),
 * mirroring `org-app-list-functions.test.ts`: a reload only re-attempts a
 * failed Organization resync because `loadCurrentSession` actually calls
 * `retryPendingResync` when a marker is pending
 * (`session-functions.ts:56-58` pre-refactor, now inside
 * `loadCurrentSessionForRequest`). Deleting that wiring left the full suite
 * green — nothing imported this file.
 *
 * `loadCurrentSessionForRequest` takes `bindings`/`request` as explicit
 * parameters rather than reading `workerEnv`/`getRequest()` internally, so
 * it can run here against real Miniflare D1 + KV without the framework's
 * build-time transform (which plain vitest does not apply, and which the
 * exported `loadCurrentSession` server function needs to behave correctly).
 */

const TOKEN = `spl_${"d3e4f5".padEnd(64, "0")}`;
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
});

afterEach(async () => {
  await mf.dispose();
});

function requestWithSessionCookie(): Request {
  return new Request("https://control-panel.example.test/", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` },
  });
}

describe("loadCurrentSessionForRequest", () => {
  it("re-attempts a pending Organization resync on load, returning the previously-missing Organization and clearing the marker", async () => {
    await seedOrganization(bindings.DB, "org_000", "org-000");

    // The stale principal predates the Organization create this session is
    // meant to reflect: the membership row exists in D1, but the session
    // snapshot does not carry it yet, exactly as a failed post-create resync
    // would leave it.
    const stale: StoredSession = {
      version: 2,
      userId: "user_cap",
      workosSessionId: "session_cap",
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      orgs: [],
    };
    await refreshSession(bindings.SESSION_STORE, tokenHash, stale);
    await markPendingResync(bindings.SESSION_STORE, tokenHash, {
      resource: "organization",
      slug: "org-000",
      reason: "unknown Organization role in session materialization",
      remedy: "retry",
    });

    const result = await loadCurrentSessionForRequest(bindings, requestWithSessionCookie());

    if (result.kind !== "authenticated") {
      throw new Error(`expected kind "authenticated", got "${result.kind}"`);
    }
    // This is the mutation target: comment out the retry call inside
    // `loadCurrentSessionForRequest` (leave only `const session = rehydrated`)
    // and this assertion fails, because the Organization the User created is
    // still absent from the returned principal.
    expect(result.session.orgs.map((org) => org.orgSlug)).toContain("org-000");
    // "Reload to check again" is only honest if the marker actually clears,
    // in the notice this same load renders...
    expect(result.pendingOrgResync).toBeNull();
    // ...and durably, so a second load does not resurface it.
    expect(await readPendingResync(bindings.SESSION_STORE, tokenHash, "organization")).toBeNull();
  }, 20_000);

  it("swallows a failed retry and reports the still-pending notice, rather than losing the signal", async () => {
    const staleWithoutWorkosId: StoredSession = {
      version: 2,
      userId: "user_cap",
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      orgs: [],
    };
    await refreshSession(bindings.SESSION_STORE, tokenHash, staleWithoutWorkosId);
    await markPendingResync(bindings.SESSION_STORE, tokenHash, {
      resource: "organization",
      slug: "org-000",
      reason: "boom",
      remedy: "retry",
    });

    const result = await loadCurrentSessionForRequest(bindings, requestWithSessionCookie());

    if (result.kind !== "authenticated") {
      throw new Error(`expected kind "authenticated", got "${result.kind}"`);
    }
    expect(result.pendingOrgResync).toEqual({
      slug: "org-000",
      reason: "boom",
      remedy: "retry",
    });
    expect(
      await readPendingResync(bindings.SESSION_STORE, tokenHash, "organization"),
    ).not.toBeNull();
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
