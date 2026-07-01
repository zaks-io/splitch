import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { createdAt, userRef } from "./columns.js";
import { apps, environments } from "./identity.js";

/**
 * Credential-domain D1 tables: Client Keys (public, key material stored) and API
 * Keys (secret; only the hash is stored, raw value surfaced once at creation).
 * Source of truth: docs/spec/contracts/storage-schemas-d1-experiment.md.
 *
 * Co-scoping (ADR-0027): both tables carry `app_id` and `environment_id` — SDK
 * credentials are scoped to exactly one Environment.
 */

export const clientKeys = sqliteTable("client_keys", {
  keyId: text("key_id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id),
  // Co-scoped with app_id (ADR-0027).
  environmentId: text("environment_id")
    .notNull()
    .references(() => environments.id),
  // Public value shipped to client code.
  keyMaterial: text("key_material").notNull(),
  // JSON array (nullable): null = open to all origins (auto-provision default,
  // loudly flagged); [] = closed, serves nothing; non-empty = closed except
  // listed origins (ADR-0034 §1).
  originAllowlist: text("origin_allowlist"),
  rateLimitRps: integer("rate_limit_rps"),
  revokedAt: text("revoked_at"),
  createdAt: createdAt(),
  createdBy: userRef("created_by"),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    keyId: text("key_id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    // Co-scoped with app_id (ADR-0027).
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    // Hash of the secret value; the raw value is never stored.
    keyHash: text("key_hash").notNull(),
    // JSON array.
    scopes: text("scopes").notNull(),
    revokedAt: text("revoked_at"),
    lastRotatedAt: text("last_rotated_at"),
    createdAt: createdAt(),
    createdBy: userRef("created_by"),
  },
  (t) => [index("api_keys_key_hash_idx").on(t.keyHash)],
);
