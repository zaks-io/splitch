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

function schemaSources() {
  const dir = new URL("../packages/db/src/schema/", import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(new URL(name, dir), "utf8"));
}

/**
 * The Drizzle schema as a graph: for each table, whether it carries `app_id` and which
 * tables it points at. Parents come from both the inline `references(() => table.column)`
 * form and the composite `foreignKey({ foreignColumns: [table.column] })` form; missing
 * either would leave an ordering edge unguarded. Each `sqliteTable(` block runs until the
 * next one, so splitting on that gives one block per table.
 */
function schemaGraph() {
  const sources = schemaSources();
  const tableOfVariable = new Map();
  for (const source of sources) {
    for (const [, variable, table] of source.matchAll(
      /export const (\w+) = sqliteTable\(\s*"([a-z_0-9]+)"/g,
    )) {
      tableOfVariable.set(variable, table);
    }
  }

  const graph = new Map();
  for (const source of sources) {
    for (const block of source.split(/sqliteTable\(\s*/).slice(1)) {
      const table = block.match(/^"([a-z_0-9]+)"/)?.[1];
      if (!table) {
        continue;
      }
      const parents = new Set();
      for (const [, variable] of block.matchAll(/references\(\(\)\s*=>\s*(\w+)\./g)) {
        parents.add(tableOfVariable.get(variable));
      }
      for (const [, columns] of block.matchAll(/foreignColumns:\s*\[([^\]]*)\]/g)) {
        for (const [, variable] of columns.matchAll(/(\w+)\./g)) {
          parents.add(tableOfVariable.get(variable));
        }
      }
      // A self-reference imposes no ordering between separate DELETE statements.
      parents.delete(table);
      parents.delete(undefined);
      graph.set(table, { hasAppId: /text\("app_id"\)/.test(block), parents });
    }
  }
  return graph;
}

function appScopedSchemaTables() {
  return [...schemaGraph()]
    .filter(([, table]) => table.hasAppId)
    .map(([name]) => name)
    .sort();
}

test("cleanup deletes from every app_id table in the Drizzle schema", () => {
  const sql = buildCleanupSql();
  const schemaTables = appScopedSchemaTables();
  assert.ok(schemaTables.length > 0, "schema parse found no app_id tables");
  for (const table of schemaTables) {
    assert.match(
      sql,
      new RegExp(`DELETE FROM ${table} `),
      `cleanup never deletes ${table}, so transient rows survive or the App delete fails`,
    );
  }
});

test("cleanup removes App deletion recovery rows before their App selector disappears", () => {
  const sql = buildCleanupSql();
  const recoveryAt = sql.indexOf("DELETE FROM app_deletion_sagas ");
  const appAt = sql.indexOf("DELETE FROM apps ");
  assert.ok(
    recoveryAt !== -1 && recoveryAt < appAt,
    "cleanup deletes Apps before their durable recovery rows, leaving them orphaned",
  );
  assert.match(
    sql,
    /DELETE FROM app_deletion_sagas WHERE organization_scope_hash = '[a-f0-9]{64}'/u,
    "cleanup cannot remove recovery rows after their App selector is already gone",
  );
  assert.match(sql, new RegExp(`OR organization_id = '${SMOKE_IDS.org}'`));
});

test("cleanup names only tables that exist in the Drizzle schema", () => {
  const schemaTables = new Set([
    ...appScopedSchemaTables(),
    "app_deletion_sagas",
    "apps",
    "sentry_installations",
    "variants",
  ]);
  for (const table of buildCleanupSql().matchAll(/DELETE FROM ([a-z_]+) /g)) {
    assert.ok(schemaTables.has(table[1]), `cleanup deletes from unknown table ${table[1]}`);
  }
});

test("cleanup removes the Organization-scoped Sentry installation", () => {
  // A Sentry installation hangs off the Organization, so no transient App going
  // away takes it with it, and the partial unique index allows only one active
  // row per Organization: leaving it behind breaks the next run's install.
  assert.match(
    buildCleanupSql(),
    new RegExp(`DELETE FROM sentry_installations WHERE org_id = '${SMOKE_IDS.org}'`),
  );
});

test("cleanup removes every table the panel golden path writes to", () => {
  const sql = buildCleanupSql();
  // The golden path creates an App, Flag, Variants, Metric, Experiment, and a started Run.
  for (const table of ["experiments", "runs", "metrics", "flags", "variants", "apps"]) {
    assert.match(sql, new RegExp(`DELETE FROM ${table} `), `cleanup never deletes ${table}`);
  }
});

test("cleanup deletes every child table before the parent it references", () => {
  const sql = buildCleanupSql();
  const positionOf = (table) => sql.indexOf(`DELETE FROM ${table} `);
  let pairs = 0;
  for (const [child, { parents }] of schemaGraph()) {
    const childAt = positionOf(child);
    if (childAt === -1) {
      continue;
    }
    for (const parent of parents) {
      const parentAt = positionOf(parent);
      if (parentAt === -1) {
        continue;
      }
      pairs += 1;
      assert.ok(
        childAt < parentAt,
        `cleanup deletes ${parent} before its child ${child}; D1 rejects that foreign key ` +
          "and aborts the whole cleanup, so nothing is deleted",
      );
    }
  }
  assert.ok(pairs > 0, "no foreign-key pairs were checked; the schema parse found no edges");
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
