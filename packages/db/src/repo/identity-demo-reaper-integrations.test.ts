import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";

const NOW = "2026-08-26T08:00:00.000Z";
const EXPIRED = "2026-08-25T08:00:00.000Z";
const IDS = {
  org: "org_reaper_integrations",
  user: "user_reaper_integrations",
  app: "app_reaper_integrations",
  env: "env_reaper_integrations",
  convex: "00000000-0000-4000-8000-000000000021",
  convexDelivery: "00000000-0000-4000-8000-000000000022",
  cloudflare: "00000000-0000-4000-8000-000000000023",
  cloudflareDelivery: "00000000-0000-4000-8000-000000000024",
  sentry: "00000000-0000-4000-8000-000000000025",
  approvalRequest: "apr_reaper_integrations",
  approvalReview: "arv_reaper_integrations",
  eventDefinition: "evd_reaper_integrations",
  eventDefinitionVersion: "evv_reaper_integrations",
};

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  await seed();
});

afterEach(async () => local.dispose());

/**
 * A demo Organization that used an integration, an Approval, or an Event
 * Definition still has to reap. Every one of these tables foreign-keys the App,
 * so a table the reap forgets does not leak quietly: the batch fails its foreign
 * key and the Organization outlives its expiry forever.
 */
describe("demo reaper over the full App subtree", () => {
  it("clears integration installations, deliveries, Approvals, and Event Definitions", async () => {
    await expect(repo.identity.reapExpiredProvisionalOrganizations(NOW)).resolves.toEqual({
      candidates: 1,
      reaped: 1,
    });

    for (const table of [
      "convex_installations",
      "config_webhook_deliveries",
      "cloudflare_installations",
      "cloudflare_config_deliveries",
      "sentry_installations",
      "approval_requests",
      "approval_reviews",
      "event_definitions",
      "event_definition_versions",
      "app_deletion_sagas",
      "apps",
      "organizations",
    ]) {
      expect(await count(table), `${table} outlived the reap`).toBe(0);
    }
  }, 15_000);
});

async function count(table: string): Promise<number> {
  const row = await local.d1
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function seed(): Promise<void> {
  for (const [sql, ...values] of seedRows()) {
    await local.d1
      .prepare(sql)
      .bind(...values)
      .run();
  }
}

function seedRows(): [string, ...unknown[]][] {
  return [
    [
      "INSERT INTO organizations (id, name, slug, plan, is_provisional, demo_expires_at, created_at, updated_at) VALUES (?, ?, ?, 'free', 1, ?, ?, ?)",
      IDS.org,
      IDS.org,
      IDS.org,
      EXPIRED,
      NOW,
      NOW,
    ],
    [
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      IDS.app,
      IDS.org,
      IDS.app,
      IDS.app,
      NOW,
      NOW,
      IDS.user,
    ],
    [
      "INSERT INTO environments (id, app_id, key, name, created_at, updated_at, created_by) VALUES (?, ?, 'production', 'Production', ?, ?, ?)",
      IDS.env,
      IDS.app,
      NOW,
      NOW,
      IDS.user,
    ],
    ...integrationRows(),
    ...approvalRows(),
    ...eventDefinitionRows(),
    [
      "INSERT INTO app_deletion_sagas (app_id, generation_id, organization_id, actor_id, delete_before_ts, phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'started', ?, ?)",
      IDS.app,
      IDS.app,
      IDS.org,
      IDS.user,
      NOW,
      NOW,
      NOW,
    ],
  ];
}

function integrationRows(): [string, ...unknown[]][] {
  return [
    [
      `INSERT INTO convex_installations (installation_id, app_id, environment_id, callback_url, secret_ciphertext, secret_key_version, secret_fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, 'https://example.convex.site/splitch/configuration', 'ciphertext', 'v1', 'fingerprint', 'active', ?, ?)`,
      IDS.convex,
      IDS.app,
      IDS.env,
      NOW,
      NOW,
    ],
    [
      `INSERT INTO config_webhook_deliveries (delivery_id, installation_id, app_id, environment_id, environment_version, body_json, state, attempt_count, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 1, '{}', 'pending', 0, ?, ?)`,
      IDS.convexDelivery,
      IDS.convex,
      IDS.app,
      IDS.env,
      NOW,
      NOW,
    ],
    [
      `INSERT INTO cloudflare_installations (installation_id, app_id, environment_id, endpoint, secret_ciphertext, secret_key_version, secret_fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, 'https://example.workers.dev/splitch/configuration', 'ciphertext', 'v1', 'fingerprint', 'active', ?, ?)`,
      IDS.cloudflare,
      IDS.app,
      IDS.env,
      NOW,
      NOW,
    ],
    [
      `INSERT INTO cloudflare_config_deliveries (delivery_id, installation_id, app_id, environment_id, environment_version, state, attempt_count, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 1, 'pending', 0, ?, ?)`,
      IDS.cloudflareDelivery,
      IDS.cloudflare,
      IDS.app,
      IDS.env,
      NOW,
      NOW,
    ],
    // The one installation that hangs off the Organization rather than the App,
    // so it is the one step whose predicate no App going away would satisfy.
    [
      `INSERT INTO sentry_installations (installation_id, org_id, webhook_url, secret_ciphertext, secret_key_version, secret_fingerprint, status, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'https://sentry.io/api/0/organizations/acme/flags/hooks/provider/generic/', 'ciphertext', 'v1', 'fingerprint', 'active', 0, ?, ?, ?)`,
      IDS.sentry,
      IDS.org,
      NOW,
      NOW,
      NOW,
    ],
  ];
}

function approvalRows(): [string, ...unknown[]][] {
  return [
    [
      `INSERT INTO approval_requests (id, app_id, operation, target_type, target_id, target_version, policy_contexts, diff, status, proposed_by, proposed_via, proposed_at, idempotency_key, request_hash)
       VALUES (?, ?, 'flag_config.update', 'flag_config', 'cfg_reaper', 'v1', '[]', '{}', 'pending', ?, 'api', ?, ?, 'hash')`,
      IDS.approvalRequest,
      IDS.app,
      IDS.user,
      NOW,
      IDS.approvalRequest,
    ],
    [
      `INSERT INTO approval_reviews (id, app_id, approval_request_id, action, outcome, reviewed_by, reviewed_via, reviewed_at, idempotency_key, request_hash)
       VALUES (?, ?, ?, 'approve', 'applied', ?, 'api', ?, ?, 'hash')`,
      IDS.approvalReview,
      IDS.app,
      IDS.approvalRequest,
      IDS.user,
      NOW,
      IDS.approvalReview,
    ],
  ];
}

function eventDefinitionRows(): [string, ...unknown[]][] {
  return [
    [
      `INSERT INTO event_definitions (id, app_id, name, family, display_name, state, created_at, updated_at)
       VALUES (?, ?, 'checkout_completed', 'product', 'Checkout completed', 'draft', ?, ?)`,
      IDS.eventDefinition,
      IDS.app,
      NOW,
      NOW,
    ],
    [
      `INSERT INTO event_definition_versions (id, app_id, event_definition_id, version, schema_hash, fields, dimensions, published_at)
       VALUES (?, ?, ?, 1, 'hash', '[]', '[]', ?)`,
      IDS.eventDefinitionVersion,
      IDS.app,
      IDS.eventDefinition,
      NOW,
    ],
  ];
}
