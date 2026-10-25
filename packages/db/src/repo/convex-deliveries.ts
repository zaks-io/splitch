import { sql } from "drizzle-orm";
import { configWebhookDeliveries } from "../schema/integrations";
import { createDb } from "./client";
import type { ConfigWebhookDeliveryRow } from "./convex-integrations";
import { buildDueConvexDeliveriesQuery } from "./scheduled-due-predicates";

/**
 * Claims go to the installation that has waited longest, counting a failing installation's wait
 * from this much later. Healthy installations pass failing ones that started waiting up to this
 * long before them, so a fan-out to hundreds of dead receivers does not queue ahead of them. It is
 * an ordering penalty, not a strict priority: a recovered receiver still reaches the front while
 * healthy work fills every claim. It matches the preparation cooldown and the last retry step.
 */
const FAILING_INSTALLATION_CLAIM_DELAY = "+30 minutes";

/**
 * An installation joins the queue when its oldest outstanding version is created, and rejoins at
 * the back after each attempt: every owned completion and preparation deferral stamps
 * `updated_at`. A newer version cannot restart the wait, and a receiver that keeps failing cannot
 * keep the front.
 */
const waitingSince = sql`max(
  datetime((SELECT oldest.created_at FROM config_webhook_deliveries oldest
    INDEXED BY config_webhook_delivery_outstanding_idx
    WHERE oldest.installation_id = installation.installation_id
      AND oldest.state IN ('pending', 'leased')
    ORDER BY oldest.environment_version LIMIT 1)),
  datetime(installation.updated_at))`;

export async function claimDueConvexDeliveries(
  d1: D1Database,
  now: string,
  leaseOwner: string,
  leaseExpiresAt: string,
  limit: number,
): Promise<ConfigWebhookDeliveryRow[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("Convex delivery claim limit must be a positive integer");
  const due = buildDueConvexDeliveriesQuery(now);
  // Start with eligible installations so blocked history cannot inflate the due-row scan.
  const db = createDb(d1);
  const [leased, claimed] = await db.batch([
    db
      .update(configWebhookDeliveries)
      .set({ state: "leased", leaseOwner, leaseExpiresAt })
      .where(sql`delivery_id IN (
          SELECT delivery.delivery_id FROM convex_installations installation ${due}
          ORDER BY datetime(${waitingSince},
              CASE WHEN installation.latest_delivery_error_json IS NULL THEN '+0 minutes'
                ELSE ${FAILING_INSTALLATION_CLAIM_DELAY} END),
            delivery.delivery_id
          LIMIT ${limit}
        )`)
      .returning({ deliveryId: configWebhookDeliveries.deliveryId }),
    db
      .select({
        deliveryId: sql<ConfigWebhookDeliveryRow["deliveryId"]>`delivery.delivery_id`,
        installationId: sql<ConfigWebhookDeliveryRow["installationId"]>`delivery.installation_id`,
        callbackUrl: sql<ConfigWebhookDeliveryRow["callbackUrl"]>`installation.callback_url`,
        secretCiphertext: sql<
          ConfigWebhookDeliveryRow["secretCiphertext"]
        >`installation.secret_ciphertext`,
        secretKeyVersion: sql<
          ConfigWebhookDeliveryRow["secretKeyVersion"]
        >`installation.secret_key_version`,
        environmentVersion: sql<
          ConfigWebhookDeliveryRow["environmentVersion"]
        >`delivery.environment_version`,
        bodyJson: sql<ConfigWebhookDeliveryRow["bodyJson"]>`delivery.body_json`,
        attemptCount: sql<ConfigWebhookDeliveryRow["attemptCount"]>`delivery.attempt_count`,
      })
      .from(sql`config_webhook_deliveries delivery JOIN convex_installations installation
          ON installation.installation_id = delivery.installation_id`)
      .where(sql`delivery.state = 'leased' AND delivery.lease_owner = ${leaseOwner}
          AND installation.status = 'active'`)
      .orderBy(sql`delivery.next_attempt_at`, sql`delivery.delivery_id`),
  ]);
  if (!leased || !claimed)
    throw new Error("Convex delivery claim: D1 batch did not return both statement results");
  const updatedIds = new Set(leased.map((row) => row.deliveryId));
  return claimed.filter((row) => updatedIds.has(row.deliveryId));
}

export interface ConvexDeliveryFinish {
  state: "delivered" | "pending" | "terminal";
  now: string;
  nextAttemptAt?: string;
  errorJson?: string;
}

export async function finishConvexDelivery(
  d1: D1Database,
  deliveryId: string,
  leaseOwner: string,
  input: ConvexDeliveryFinish,
): Promise<string | null> {
  // An owned outcome invalidates the lifecycle generation atomically. Registrations and checks replace it too,
  // so a delayed deletion probe cannot override newer activity, even at the same timestamp.
  const probeToken = input.state === "terminal" ? crypto.randomUUID() : null;
  const delivered = input.state === "delivered";
  // The body is a version-only nudge (ADR 0049), so an older version cannot succeed where a newer
  // one was terminally rejected. Left pending, each older version would cost another claim.
  const supersedesOlder = input.state !== "pending";
  // Installation health must read the owned lease before the outbox update clears it.
  const results = await d1.batch([
    d1
      .prepare(`UPDATE convex_installations SET
        last_delivered_version = CASE WHEN ? THEN MAX(COALESCE(last_delivered_version, 0), (SELECT environment_version FROM config_webhook_deliveries WHERE delivery_id = ?)) ELSE last_delivered_version END,
        last_delivered_at = CASE WHEN ? THEN ? ELSE last_delivered_at END,
        latest_delivery_error_json = CASE WHEN ? THEN NULL ELSE ? END,
        updated_at = ?, deployment_probe_token = ?
        WHERE installation_id = (SELECT installation_id FROM config_webhook_deliveries WHERE delivery_id = ?)
          AND status = 'active'
          AND EXISTS (SELECT 1 FROM config_webhook_deliveries
            WHERE delivery_id = ? AND state = 'leased' AND lease_owner = ?)`)
      .bind(
        delivered ? 1 : 0,
        deliveryId,
        delivered ? 1 : 0,
        input.now,
        delivered ? 1 : 0,
        input.errorJson ?? null,
        input.now,
        probeToken,
        deliveryId,
        deliveryId,
        leaseOwner,
      ),
    d1
      .prepare(`UPDATE config_webhook_deliveries SET state = 'suppressed',
          lease_owner = NULL, lease_expires_at = NULL
        WHERE installation_id = (SELECT installation_id FROM config_webhook_deliveries WHERE delivery_id = ?)
          AND (state = 'pending' OR (state = 'leased' AND lease_expires_at <= ?))
          AND environment_version < (SELECT environment_version FROM config_webhook_deliveries WHERE delivery_id = ?)
          AND ? = 1
          AND EXISTS (SELECT 1 FROM config_webhook_deliveries owned
            JOIN convex_installations installation ON installation.installation_id = owned.installation_id
            WHERE owned.delivery_id = ? AND owned.state = 'leased' AND owned.lease_owner = ?
              AND installation.status = 'active')`)
      .bind(deliveryId, input.now, deliveryId, supersedesOlder ? 1 : 0, deliveryId, leaseOwner),
    d1
      .prepare(`UPDATE config_webhook_deliveries SET state = ?, attempt_count = attempt_count + 1,
        next_attempt_at = COALESCE(?, next_attempt_at), last_error_json = ?, delivered_at = ?,
        lease_owner = NULL, lease_expires_at = NULL
        WHERE delivery_id = ? AND state = 'leased' AND lease_owner = ?
          AND EXISTS (SELECT 1 FROM convex_installations
            WHERE installation_id = config_webhook_deliveries.installation_id AND status = 'active')`)
      .bind(
        input.state,
        input.nextAttemptAt ?? null,
        input.errorJson ?? null,
        delivered ? input.now : null,
        deliveryId,
        leaseOwner,
      ),
  ]);
  return ownedProbeToken(results[0], probeToken);
}

function ownedProbeToken(observation: D1Result | undefined, probeToken: string | null) {
  if (!observation) throw new Error("Convex delivery completion: missing D1 result");
  return observation.meta.changes > 0 ? probeToken : null;
}
