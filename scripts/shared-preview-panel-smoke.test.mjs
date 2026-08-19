import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  ensurePanelSmokeUser,
  generatePanelPassword,
  PANEL_SMOKE_EMAIL,
} from "./lib/shared-preview-panel-user.mjs";
import {
  buildCleanupSql,
  buildPanelUserSql,
  SMOKE_IDS,
  TRANSIENT_APP_KEY_PREFIXES,
} from "./seed-shared-preview-smoke-sql.mjs";

const WORKOS_USER_ID = "user_01JQPANELSMOKE0000000000";

/**
 * D1 enforces foreign keys, so a new `app_id` table that cleanup does not delete makes the
 * transient App delete fail outright. Reads the Drizzle schema, where each `sqliteTable(`
 * block runs until the next one, and treats a block declaring `app_id` as in scope.
 */
function appScopedSchemaTables() {
  const dir = new URL("../packages/db/src/schema/", import.meta.url);
  const tables = new Set();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const blocks = readFileSync(new URL(file, dir), "utf8")
      .split(/sqliteTable\(\s*/)
      .slice(1);
    for (const block of blocks) {
      const name = block.match(/^"([a-z_]+)"/)?.[1];
      if (name && /text\("app_id"\)/.test(block)) {
        tables.add(name);
      }
    }
  }
  return [...tables].sort();
}

test("cleanup deletes from every app_id table in the Drizzle schema", () => {
  const sql = buildCleanupSql();
  const schemaTables = appScopedSchemaTables();
  assert.ok(schemaTables.length > 0, "schema parse found no app_id tables");
  for (const table of schemaTables) {
    assert.match(
      sql,
      new RegExp(`DELETE FROM ${table} `),
      `cleanup never deletes ${table}, so the transient App delete fails on its foreign key`,
    );
  }
});

test("cleanup names only tables that exist in the Drizzle schema", () => {
  const schemaTables = new Set([...appScopedSchemaTables(), "apps", "variants"]);
  for (const table of buildCleanupSql().matchAll(/DELETE FROM ([a-z_]+) /g)) {
    assert.ok(schemaTables.has(table[1]), `cleanup deletes from unknown table ${table[1]}`);
  }
});

test("cleanup removes every table the panel golden path writes to", () => {
  const sql = buildCleanupSql();
  // The golden path creates an App, Flag, Variants, Metric, Experiment, and a started Run.
  for (const table of ["experiments", "runs", "metrics", "flags", "variants", "apps"]) {
    assert.match(sql, new RegExp(`DELETE FROM ${table} `), `cleanup never deletes ${table}`);
  }
  // Children before parents, or the delete strands rows behind foreign keys.
  assert.ok(sql.indexOf("DELETE FROM runs ") < sql.indexOf("DELETE FROM experiments "));
  assert.ok(sql.indexOf("DELETE FROM experiments ") < sql.indexOf("DELETE FROM apps "));
  assert.ok(sql.indexOf("DELETE FROM variants ") < sql.indexOf("DELETE FROM flags "));
});

test("cleanup is scoped to transient Apps in the smoke Organization only", () => {
  const sql = buildCleanupSql();
  const scopes = sql.match(/SELECT id FROM apps WHERE organization_id = '([^']+)'/g) ?? [];
  assert.ok(scopes.length > 0);
  for (const scope of scopes) {
    assert.ok(scope.includes(SMOKE_IDS.org), `cleanup escaped the smoke Organization: ${scope}`);
  }
  assert.match(sql, /key LIKE 'panel-smoke-app-%'/);
  // The stable seeded App must survive; only prefixed transients go.
  assert.doesNotMatch(sql, /DELETE FROM apps WHERE organization_id = '[^']+';/);
});

test("the panel spec only creates Apps under a cleaned-up prefix", () => {
  const actions = readFileSync("tests/shared-preview/panel-actions.ts", "utf8");
  const prefix = actions.match(/PANEL_APP_KEY_PREFIX = "([a-z-]+)"/)?.[1];
  assert.ok(prefix, "panel actions must declare PANEL_APP_KEY_PREFIX");
  assert.ok(
    TRANSIENT_APP_KEY_PREFIXES.includes(`${prefix}-`),
    `panel App key prefix "${prefix}-" is not in TRANSIENT_APP_KEY_PREFIXES, so cleanup would orphan it`,
  );
  // The App slug must come from that constant, not a second hardcoded literal.
  assert.match(actions, /uniqueKey\(config, PANEL_APP_KEY_PREFIX\)/);
});

test("panel access is granted to the real WorkOS user id, never a synthetic one", () => {
  const sql = buildPanelUserSql("2026-08-19T00:00:00.000Z", WORKOS_USER_ID);
  assert.match(sql, new RegExp(`INSERT INTO org_memberships[\\s\\S]*${WORKOS_USER_ID}`));
  assert.match(sql, new RegExp(`INSERT INTO app_memberships[\\s\\S]*${WORKOS_USER_ID}`));
  assert.throws(() => buildPanelUserSql("now", SMOKE_IDS.user), /not a WorkOS user id/);
  assert.throws(() => buildPanelUserSql("now", "'; DROP TABLE apps;--"), /not a WorkOS user id/);
});

test("generated passwords are unique, long, and URL-safe", () => {
  const first = generatePanelPassword();
  assert.notEqual(first, generatePanelPassword());
  assert.ok(first.length >= 40);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
});

test("provisioning updates an existing AuthKit account and returns its id", async () => {
  const calls = [];
  const result = await ensurePanelSmokeUser({
    apiKey: "sk_test",
    fetchImpl: fakeWorkOs(calls, { existingId: WORKOS_USER_ID }),
    password: "fixed-password",
  });
  assert.deepEqual(result, {
    email: PANEL_SMOKE_EMAIL,
    password: "fixed-password",
    userId: WORKOS_USER_ID,
  });
  assert.equal(calls[1].method, "PUT");
  assert.deepEqual(calls[1].body, { email_verified: true, password: "fixed-password" });
});

test("provisioning creates a verified AuthKit account when none exists", async () => {
  const calls = [];
  const result = await ensurePanelSmokeUser({
    apiKey: "sk_test",
    fetchImpl: fakeWorkOs(calls, { existingId: null }),
    password: "fixed-password",
  });
  assert.equal(result.userId, WORKOS_USER_ID);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].body.email_verified, true);
});

test("a missing API key fails before any network call", async () => {
  await assert.rejects(
    ensurePanelSmokeUser({ apiKey: "", fetchImpl: () => assert.fail("must not fetch") }),
    /WORKOS_API_KEY is required/,
  );
});

test("a disabled password connection reports the exact dashboard change needed", async () => {
  await assert.rejects(
    ensurePanelSmokeUser({
      apiKey: "sk_test",
      fetchImpl: async (_url, init) =>
        init.method === "GET"
          ? jsonResponse({ data: [] })
          : new Response("password authentication is not enabled", { status: 422 }),
    }),
    /Enable the Email \+ Password authentication method/,
  );
});

test("an unverified AuthKit account fails loudly instead of reaching login", async () => {
  await assert.rejects(
    ensurePanelSmokeUser({
      apiKey: "sk_test",
      fetchImpl: async (_url, init) =>
        init.method === "GET"
          ? jsonResponse({ data: [] })
          : jsonResponse({ email_verified: false, id: WORKOS_USER_ID }),
    }),
    /not email-verified/,
  );
});

function fakeWorkOs(calls, { existingId }) {
  return async (url, init) => {
    calls.push({ body: init.body ? JSON.parse(init.body) : undefined, method: init.method, url });
    if (init.method === "GET") {
      return jsonResponse({ data: existingId ? [{ id: existingId }] : [] });
    }
    return jsonResponse({ email_verified: true, id: WORKOS_USER_ID });
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
