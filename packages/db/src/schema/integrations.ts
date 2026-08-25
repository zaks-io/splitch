import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt } from "./columns";
import { apps, environments } from "./identity";

export const convexInstallations = sqliteTable(
  "convex_installations",
  {
    installationId: text("installation_id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    callbackUrl: text("callback_url").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretKeyVersion: text("secret_key_version").notNull(),
    secretFingerprint: text("secret_fingerprint").notNull(),
    lastRotationId: text("last_rotation_id"),
    lastRotationFingerprint: text("last_rotation_fingerprint"),
    status: text("status").notNull(),
    lastDeliveredVersion: integer("last_delivered_version"),
    lastDeliveredAt: text("last_delivered_at"),
    latestDeliveryErrorJson: text("latest_delivery_error_json"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("convex_installations_scope_status_idx").on(
      table.appId,
      table.environmentId,
      table.status,
    ),
    uniqueIndex("convex_installations_scope_id_unique").on(
      table.appId,
      table.environmentId,
      table.installationId,
    ),
  ],
);

export const configWebhookDeliveries = sqliteTable(
  "config_webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => convexInstallations.installationId),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    environmentVersion: integer("environment_version").notNull(),
    bodyJson: text("body_json").notNull(),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    lastErrorJson: text("last_error_json"),
    createdAt: createdAt(),
    deliveredAt: text("delivered_at"),
  },
  (table) => [
    uniqueIndex("config_webhook_delivery_installation_version_unique").on(
      table.installationId,
      table.environmentVersion,
    ),
    index("config_webhook_delivery_lease_idx").on(
      table.state,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  ],
);
