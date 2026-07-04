import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1";

const NOW = "2026-07-03T08:00:00.000Z";
const EXPIRED = "2026-07-02T08:00:00.000Z";
const FUTURE = "2026-07-04T08:00:00.000Z";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

describe("demo reaper", () => {
  it("removes generated-schema Flag Configuration and credential children before roots", async () => {
    const expired = await seedDemoGraph(local.d1, "expired", true, EXPIRED);
    const future = await seedDemoGraph(local.d1, "future", true, FUTURE);
    const claimed = await seedDemoGraph(local.d1, "claimed", false, EXPIRED);

    await expect(repo.identity.reapExpiredProvisionalOrganizations(NOW)).resolves.toEqual({
      candidates: 1,
      reaped: 1,
    });

    await expectRefs(expired, 0);
    await expectRefs(future, 1);
    await expectRefs(claimed, 1);
  });
});

async function seedDemoGraph(
  d1: D1Database,
  suffix: string,
  provisional: boolean,
  demoExpiresAt: string,
): Promise<SeededGraph> {
  const ids = demoIds(suffix);
  await execMany(d1, [
    ...identityRows(ids, provisional, demoExpiresAt),
    ...flagCredentialRows(ids),
  ]);
  return { refs: rowRefs(ids) };
}

function demoIds(suffix: string): DemoIds {
  const id = (kind: string) => `${kind}_reaper_${suffix}`;
  return {
    orgId: id("org"),
    userId: id("user"),
    appId: id("app"),
    envId: id("env"),
    flagId: id("flag"),
    variantId: id("variant"),
    flagConfigId: id("flag_config"),
    apiKeyId: id("api_key"),
    clientKeyId: id("client_key"),
    privacyRequestId: id("privacy_request"),
    apiHash: id("api_hash"),
    clientMaterial: id("client_material"),
  };
}

function identityRows(ids: DemoIds, provisional: boolean, demoExpiresAt: string): SqlRow[] {
  return [
    [
      "INSERT INTO organizations (id, name, plan, is_provisional, demo_expires_at, created_at, updated_at) VALUES (?, ?, 'free', ?, ?, ?, ?)",
      ids.orgId,
      ids.orgId,
      provisional ? 1 : 0,
      demoExpiresAt,
      NOW,
      NOW,
    ],
    ["INSERT INTO org_memberships VALUES (?, ?, 'owner', ?)", ids.orgId, ids.userId, NOW],
    [
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ids.appId,
      ids.orgId,
      ids.appId,
      ids.appId,
      NOW,
      NOW,
      ids.userId,
    ],
    ["INSERT INTO app_memberships VALUES (?, ?, 'owner', ?)", ids.appId, ids.userId, NOW],
    [
      "INSERT INTO environments (id, app_id, key, name, created_at, updated_at, created_by) VALUES (?, ?, 'production', 'Production', ?, ?, ?)",
      ids.envId,
      ids.appId,
      NOW,
      NOW,
      ids.userId,
    ],
  ];
}

function flagCredentialRows(ids: DemoIds): SqlRow[] {
  return [
    [
      "INSERT INTO flags (id, app_id, key, name, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ids.flagId,
      ids.appId,
      ids.flagId,
      ids.flagId,
      NOW,
      NOW,
      ids.userId,
    ],
    [
      "INSERT INTO variants (id, flag_id, name, value, created_at) VALUES (?, ?, 'control', ?, ?)",
      ids.variantId,
      ids.flagId,
      JSON.stringify("control"),
      NOW,
    ],
    [
      "INSERT INTO flag_configs (id, app_id, environment_id, flag_id, enabled, available_variant_names, default_variant_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
      ids.flagConfigId,
      ids.appId,
      ids.envId,
      ids.flagId,
      JSON.stringify(["control"]),
      ids.variantId,
      NOW,
      NOW,
    ],
    [
      "INSERT INTO api_keys (key_id, app_id, environment_id, key_hash, scopes, created_at, created_by) VALUES (?, ?, ?, ?, '[]', ?, ?)",
      ids.apiKeyId,
      ids.appId,
      ids.envId,
      ids.apiHash,
      NOW,
      ids.userId,
    ],
    [
      "INSERT INTO client_keys (key_id, app_id, environment_id, key_material, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      ids.clientKeyId,
      ids.appId,
      ids.envId,
      ids.clientMaterial,
      NOW,
      ids.userId,
    ],
    [
      "INSERT INTO privacy_requests (request_id, org_id, app_id, request_type, subject_type, subject_ref, requested_by, status, received_at, ack_due_at, response_due_at) VALUES (?, ?, ?, 'delete', 'user', ?, ?, 'received', ?, ?, ?)",
      ids.privacyRequestId,
      ids.orgId,
      ids.appId,
      ids.userId,
      ids.userId,
      NOW,
      NOW,
      NOW,
    ],
  ];
}

function rowRefs(ids: DemoIds): RowRef[] {
  return [
    { table: "organizations", column: "id", value: ids.orgId },
    { table: "org_memberships", column: "org_id", value: ids.orgId },
    { table: "apps", column: "id", value: ids.appId },
    { table: "app_memberships", column: "app_id", value: ids.appId },
    { table: "environments", column: "id", value: ids.envId },
    { table: "flags", column: "id", value: ids.flagId },
    { table: "variants", column: "id", value: ids.variantId },
    { table: "flag_configs", column: "flag_id", value: ids.flagId },
    { table: "api_keys", column: "key_id", value: ids.apiKeyId },
    { table: "client_keys", column: "key_id", value: ids.clientKeyId },
    { table: "privacy_requests", column: "request_id", value: ids.privacyRequestId },
  ];
}

async function expectRefs(graph: SeededGraph, expectedCount: number): Promise<void> {
  for (const ref of graph.refs) {
    expect(await count(ref)).toBe(expectedCount);
  }
}

async function count(ref: RowRef): Promise<number> {
  const row = await local.d1
    .prepare(`SELECT COUNT(*) AS count FROM ${ref.table} WHERE ${ref.column} = ?`)
    .bind(ref.value)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function execMany(d1: D1Database, rows: SqlRow[]): Promise<void> {
  for (const [sql, ...values] of rows) {
    await d1
      .prepare(sql)
      .bind(...values)
      .run();
  }
}

interface SeededGraph {
  refs: RowRef[];
}

interface DemoIds {
  orgId: string;
  userId: string;
  appId: string;
  envId: string;
  flagId: string;
  variantId: string;
  flagConfigId: string;
  apiKeyId: string;
  clientKeyId: string;
  privacyRequestId: string;
  apiHash: string;
  clientMaterial: string;
}

interface RowRef {
  table: TableName;
  column: string;
  value: string;
}

type SqlRow = [sql: string, ...values: unknown[]];

type TableName =
  | "api_keys"
  | "app_memberships"
  | "apps"
  | "client_keys"
  | "environments"
  | "flag_configs"
  | "flags"
  | "organizations"
  | "org_memberships"
  | "privacy_requests"
  | "variants";
