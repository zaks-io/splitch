import { sql } from "drizzle-orm";
import { cloudflareConfigDeliveries } from "../schema/integrations";
import { createDb } from "./client";
import type { CloudflareDeliveryRow } from "./cloudflare-integrations";
import { buildDueCloudflareDeliveriesQuery } from "./scheduled-due-predicates";
import type { EnvScope, TenantScope } from "./scope";
import { assertMintedScope } from "./scope";

export async function claimDueCloudflareDeliveries(
  d1: D1Database,
  now: string,
  leaseOwner: string,
  leaseExpiresAt: string,
  limit: number,
  scope?: TenantScope,
): Promise<CloudflareDeliveryRow[]> {
  if (scope) assertMintedScope(scope);
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("Cloudflare delivery claim limit must be a positive integer");
  const due = buildDueCloudflareDeliveriesQuery(now, scope);
  const db = createDb(d1);
  const [leased, claimed] = await db.batch([
    db
      .update(cloudflareConfigDeliveries)
      .set({ state: "leased", leaseOwner, leaseExpiresAt })
      .where(sql`delivery_id IN (
          SELECT delivery.delivery_id FROM cloudflare_config_deliveries delivery ${due}
          ORDER BY delivery.next_attempt_at, delivery.delivery_id LIMIT ${limit}
        )`)
      .returning({ deliveryId: cloudflareConfigDeliveries.deliveryId }),
    db
      .select({
        deliveryId: sql<CloudflareDeliveryRow["deliveryId"]>`delivery.delivery_id`,
        installationId: sql<CloudflareDeliveryRow["installationId"]>`delivery.installation_id`,
        appId: sql<CloudflareDeliveryRow["appId"]>`delivery.app_id`,
        environmentId: sql<CloudflareDeliveryRow["environmentId"]>`delivery.environment_id`,
        endpoint: sql<CloudflareDeliveryRow["endpoint"]>`installation.endpoint`,
        secretCiphertext: sql<
          CloudflareDeliveryRow["secretCiphertext"]
        >`installation.secret_ciphertext`,
        secretKeyVersion: sql<
          CloudflareDeliveryRow["secretKeyVersion"]
        >`installation.secret_key_version`,
        environmentVersion: sql<
          CloudflareDeliveryRow["environmentVersion"]
        >`delivery.environment_version`,
        attemptCount: sql<CloudflareDeliveryRow["attemptCount"]>`delivery.attempt_count`,
        lastAppliedVersion: sql<
          CloudflareDeliveryRow["lastAppliedVersion"]
        >`installation.last_applied_version`,
        registeredAt: sql<CloudflareDeliveryRow["registeredAt"]>`installation.created_at`,
      })
      .from(sql`cloudflare_config_deliveries delivery INDEXED BY cloudflare_config_delivery_owner_idx JOIN cloudflare_installations installation
          ON installation.installation_id = delivery.installation_id`)
      .where(sql`delivery.state = 'leased' AND delivery.lease_owner = ${leaseOwner}
          AND installation.status = 'active'`)
      .orderBy(sql`delivery.next_attempt_at`, sql`delivery.delivery_id`),
  ]);
  if (!leased || !claimed)
    throw new Error("Cloudflare delivery claim: D1 batch did not return both statement results");
  const updatedIds = new Set(leased.map((row) => row.deliveryId));
  return claimed.filter((row) => updatedIds.has(row.deliveryId));
}

export interface CloudflareDeliveryFinish {
  state: "delivered" | "pending" | "terminal";
  now: string;
  appliedVersion?: number;
  nextAttemptAt?: string;
  errorJson?: string;
}

/**
 * The `(installation, version)` unique index means a terminal delivery for the
 * current version blocks every new one until the Environment version moves.
 * Re-registration re-arms that row so a rerun of setup retries now.
 */
export async function retryTerminalCloudflareDelivery(
  d1: D1Database,
  scope: EnvScope,
  installationId: string,
  now: string,
): Promise<void> {
  assertMintedScope(scope);
  await d1.batch([
    d1
      .prepare(`INSERT OR IGNORE INTO cloudflare_config_deliveries (
      delivery_id, installation_id, app_id, environment_id, environment_version,
      state, next_attempt_at, created_at
    ) SELECT ?, installation.installation_id, installation.app_id, installation.environment_id,
      environment.config_version, 'pending', ?, ?
      FROM cloudflare_installations installation JOIN environments environment
        ON environment.app_id = installation.app_id AND environment.id = installation.environment_id
      WHERE installation.app_id = ? AND installation.environment_id = ?
        AND installation.installation_id = ? AND installation.status = 'active'`)
      .bind(crypto.randomUUID(), now, now, scope.appId, scope.environmentId, installationId),
    d1
      .prepare(`UPDATE cloudflare_config_deliveries SET state = 'pending',
    attempt_count = 0, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
    last_error_json = NULL, delivered_at = NULL
    WHERE app_id = ? AND environment_id = ? AND installation_id = ? AND state = 'terminal'
    AND environment_version = (
      SELECT config_version FROM environments WHERE app_id = ? AND id = ?)
    AND EXISTS (SELECT 1 FROM cloudflare_installations
      WHERE installation_id = ? AND status = 'active')`)
      .bind(
        now,
        scope.appId,
        scope.environmentId,
        installationId,
        scope.appId,
        scope.environmentId,
        installationId,
      ),
  ]);
}

export async function finishCloudflareDelivery(
  d1: D1Database,
  deliveryId: string,
  leaseOwner: string,
  input: CloudflareDeliveryFinish,
): Promise<void> {
  const delivered = input.state === "delivered";
  const successful = delivered ? 1 : 0;
  const appliedVersion = input.appliedVersion ?? 0;
  const errorJson = input.errorJson ?? null;
  await d1.batch([
    d1
      .prepare(`UPDATE cloudflare_installations SET
      last_applied_version = CASE WHEN ? THEN MAX(COALESCE(last_applied_version, 0), ?) ELSE last_applied_version END,
      last_applied_at = CASE WHEN ? THEN ? ELSE last_applied_at END,
      latest_delivery_error_json = CASE
        WHEN ? THEN NULL
        WHEN (SELECT environment_version FROM cloudflare_config_deliveries WHERE delivery_id = ?)
          >= COALESCE(last_applied_version, 0) THEN ?
        ELSE latest_delivery_error_json
      END,
      updated_at = ?
      WHERE installation_id = (SELECT installation_id FROM cloudflare_config_deliveries WHERE delivery_id = ?)
      AND EXISTS (SELECT 1 FROM cloudflare_config_deliveries
        WHERE delivery_id = ? AND lease_owner = ?)`)
      .bind(
        successful,
        appliedVersion,
        successful,
        input.now,
        successful,
        deliveryId,
        errorJson,
        input.now,
        deliveryId,
        deliveryId,
        leaseOwner,
      ),
    d1
      .prepare(`UPDATE cloudflare_config_deliveries SET state = 'suppressed'
      WHERE installation_id = (SELECT installation_id FROM cloudflare_config_deliveries WHERE delivery_id = ?)
      AND state = 'pending' AND environment_version <= ?
      AND EXISTS (SELECT 1 FROM cloudflare_config_deliveries
        WHERE delivery_id = ? AND lease_owner = ?)`)
      .bind(deliveryId, delivered ? appliedVersion : -1, deliveryId, leaseOwner),
    d1
      .prepare(`UPDATE cloudflare_config_deliveries SET state = ?,
      attempt_count = attempt_count + 1, next_attempt_at = COALESCE(?, next_attempt_at),
      last_error_json = ?, delivered_at = ?, lease_owner = NULL, lease_expires_at = NULL
      WHERE delivery_id = ? AND lease_owner = ?`)
      .bind(
        input.state,
        input.nextAttemptAt ?? null,
        errorJson,
        delivered ? input.now : null,
        deliveryId,
        leaseOwner,
      ),
  ]);
}
