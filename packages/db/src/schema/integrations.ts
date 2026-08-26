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

/**
 * One Sentry organization bound to one splitch Environment.
 *
 * Environment-scoped because Sentry's change-tracking payload has no environment
 * axis: a customer's production Sentry org must not be told about dev toggles.
 *
 * There is no companion delivery table. Sentry's `change_id` is an idempotency
 * token by contract, so redelivering a batch is safe, and `last_delivered_seq`
 * over the monotonic `flag_change_events.seq` is a sufficient cursor. Retry
 * state (`attempt_count` / `next_attempt_at`) therefore lives on the
 * installation rather than per-delivery.
 */
export const sentryInstallations = sqliteTable(
  "sentry_installations",
  {
    installationId: text("installation_id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    /**
     * The full webhook URL copied out of Sentry's provider settings, stored
     * verbatim rather than rebuilt from an org slug so region hosts
     * (us./de.sentry.io) and self-hosted installs work without special-casing.
     * Host-validated on write AND on dispatch (SSRF).
     */
    webhookUrl: text("webhook_url").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretKeyVersion: text("secret_key_version").notNull(),
    secretFingerprint: text("secret_fingerprint").notNull(),
    lastRotationId: text("last_rotation_id"),
    lastRotationFingerprint: text("last_rotation_fingerprint"),
    status: text("status").notNull(),
    /** Cursor into flag_change_events.seq; NULL until the first delivery. */
    lastDeliveredSeq: integer("last_delivered_seq"),
    lastDeliveredAt: text("last_delivered_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    latestDeliveryErrorJson: text("latest_delivery_error_json"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("sentry_installations_due_idx").on(table.status, table.nextAttemptAt),
    uniqueIndex("sentry_installations_scope_id_unique").on(
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

export const cloudflareInstallations = sqliteTable(
  "cloudflare_installations",
  {
    installationId: text("installation_id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    endpoint: text("endpoint").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretKeyVersion: text("secret_key_version").notNull(),
    secretFingerprint: text("secret_fingerprint").notNull(),
    status: text("status").notNull(),
    lastAppliedVersion: integer("last_applied_version"),
    lastAppliedAt: text("last_applied_at"),
    latestDeliveryErrorJson: text("latest_delivery_error_json"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("cloudflare_installations_scope_status_idx").on(
      table.appId,
      table.environmentId,
      table.status,
    ),
    uniqueIndex("cloudflare_installations_scope_id_unique").on(
      table.appId,
      table.environmentId,
      table.installationId,
    ),
  ],
);

export const cloudflareConfigDeliveries = sqliteTable(
  "cloudflare_config_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => cloudflareInstallations.installationId),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    environmentVersion: integer("environment_version").notNull(),
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
    uniqueIndex("cloudflare_config_delivery_installation_version_unique").on(
      table.installationId,
      table.environmentVersion,
    ),
    index("cloudflare_config_delivery_lease_idx").on(
      table.state,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  ],
);
