import { applySchema, migrationStatements } from "@splitch/db/test-d1";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_ORG_LIMIT } from "./membership";
import { markPendingResync, readPendingResync } from "./pending-resync";
import {
  loadSessionFromCookieHeader,
  publicSession,
  refreshSession,
  SESSION_COOKIE_NAME,
  type StoredSession,
} from "./session";
import { tokenHash as hashOpaqueToken } from "./session-cookie";
import { resyncSessionMemberships, retryPendingResync } from "./session-resync";

/**
 * Create-at-cap, proven on the value read back OUT of KV.
 *
 * Real Miniflare D1 and real Miniflare KV, the real repository, the real
 * `refreshSession` write and the real `loadSessionFromCookieHeader` read. The
 * first version of this fix asserted on the principal BEFORE the KV write and
 * passed while the write silently dropped `orgsTruncated`, so the assertion
 * deliberately lives on the far side of the round trip.
 */

const TOKEN = `spl_${"cab".padEnd(64, "0")}`;
let tokenHash: string;

let mf: Miniflare;
let bindings: { DB: D1Database; SESSION_STORE: KVNamespace };

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
  };
});

afterEach(async () => {
  await mf.dispose();
});

describe("session resync at the Organization cap", () => {
  it("keeps the just-created Organization and reports the truncation, after the KV round trip", async () => {
    // Exactly at the cap, then one more as the Control Plane create would.
    await seedOrganizations(bindings.DB, SESSION_ORG_LIMIT);
    await seedOrganizations(bindings.DB, 1, SESSION_ORG_LIMIT);
    const newest = orgSlug(SESSION_ORG_LIMIT);
    const oldest = orgSlug(0);

    await refreshSession(bindings.SESSION_STORE, tokenHash, staleSession());
    await resyncSessionMemberships(bindings, tokenHash, staleSession());

    const loaded = await loadSessionFromCookieHeader(
      bindings.SESSION_STORE,
      `${SESSION_COOKIE_NAME}=${TOKEN}`,
    );
    if (!loaded.ok) throw new Error(`session did not load back: ${loaded.reason}`);
    const pub = publicSession(loaded.session);
    const slugs = pub.orgs.map((org) => org.orgSlug);

    // The Organization the User is about to be redirected to must be reachable.
    expect(slugs).toContain(newest);
    // The cap still holds, and the row it gave up is the one gone longest untouched.
    expect(pub.orgs).toHaveLength(SESSION_ORG_LIMIT);
    expect(slugs).not.toContain(oldest);
    // And the list does not claim to be complete.
    expect(pub.orgsTruncated).toBe(true);
    expect(loaded.session).toMatchObject({
      workosAccessToken: "access_token_cap",
      workosRefreshToken: "refresh_token_cap",
      workosAccessTokenExpiresAt: expect.any(Number),
    });
  }, 20_000);

  it("does not claim truncation when the create lands exactly on the cap", async () => {
    await seedOrganizations(bindings.DB, SESSION_ORG_LIMIT);

    await refreshSession(bindings.SESSION_STORE, tokenHash, staleSession());
    await resyncSessionMemberships(bindings, tokenHash, staleSession());

    const loaded = await loadSessionFromCookieHeader(
      bindings.SESSION_STORE,
      `${SESSION_COOKIE_NAME}=${TOKEN}`,
    );
    if (!loaded.ok) throw new Error(`session did not load back: ${loaded.reason}`);
    const pub = publicSession(loaded.session);

    expect(pub.orgs).toHaveLength(SESSION_ORG_LIMIT);
    expect(pub.orgsTruncated).toBe(false);
    expect(pub.orgs.map((org) => org.orgSlug)).toContain(orgSlug(0));
  }, 20_000);
});

describe("retryPendingResync", () => {
  it("re-attempts the resync and clears the marker on success, so a reload actually self-heals", async () => {
    await seedOrganizations(bindings.DB, 1);
    await markPendingResync(bindings.SESSION_STORE, tokenHash, {
      resource: "app",
      orgId: "org_000",
      slug: "checkout-api",
      reason: "unknown App role in session materialization",
      remedy: "retry",
    });

    const refreshed = await retryPendingResync(bindings, tokenHash, staleSession());

    // This is the mutation target: comment out the real call inside
    // `retryPendingResync` (leave only `return session`) and this assertion
    // fails, because the App the User created is still absent from the
    // returned principal.
    expect(refreshed.orgs.map((org) => org.orgSlug)).toContain(orgSlug(0));
    // "Reload to check again" is only honest if the marker actually clears —
    // otherwise the notice would reappear forever despite the resync working.
    expect(await readPendingResync(bindings.SESSION_STORE, tokenHash, "app")).toBeNull();
  });

  it("swallows a failed retry and leaves the marker pending, rather than throwing out of a read path", async () => {
    await markPendingResync(bindings.SESSION_STORE, tokenHash, {
      resource: "app",
      orgId: "org_000",
      slug: "checkout-api",
      reason: "boom",
      remedy: "retry",
    });
    const sessionWithoutWorkosId: StoredSession = { ...staleSession(), workosSessionId: undefined };

    const result = await retryPendingResync(bindings, tokenHash, sessionWithoutWorkosId);

    // This is the mutation target for removing the try/catch: without it,
    // `retryPendingResync` would reject instead of resolving here, and a
    // reload on the App list page would 500 instead of rendering the notice.
    expect(result).toBe(sessionWithoutWorkosId);
    expect(await readPendingResync(bindings.SESSION_STORE, tokenHash, "app")).not.toBeNull();
  });
});

/** The pre-create snapshot: correct for the memberships that existed before. */
function staleSession(): StoredSession {
  return {
    version: 2,
    userId: "user_cap",
    workosSessionId: "session_cap",
    workosAccessToken: "access_token_cap",
    workosRefreshToken: "refresh_token_cap",
    workosAccessTokenExpiresAt: Math.floor(Date.now() / 1000) + 1_800,
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
    orgs: [],
  };
}

function orgSlug(index: number): string {
  return `org-${String(index).padStart(3, "0")}`;
}

/**
 * `createdAt` increases with the index, so the highest index is the newest
 * membership. Ordering is what decides which row a `LIMIT` gives up, so it has
 * to be unambiguous here.
 */
async function seedOrganizations(d1: D1Database, count: number, offset = 0): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (let i = offset; i < offset + count; i += 1) {
    const id = `org_${String(i).padStart(3, "0")}`;
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    statements.push(
      d1
        .prepare(
          "INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES (?,?,?,'free',0,?,?)",
        )
        .bind(id, id, orgSlug(i), createdAt, createdAt),
      d1
        .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
        .bind(id, "user_cap", "owner", createdAt),
    );
  }
  await d1.batch(statements);
}
