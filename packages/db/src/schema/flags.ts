import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt, userRef } from "./columns";
import { apps, environments } from "./identity";

/**
 * Flag-domain D1 tables: App-level Flag DEFINITION, per-Environment Flag
 * CONFIGURATION, Variant catalog, per-Environment targeting rules, and Segments.
 * Source of truth: docs/spec/contracts/storage-schemas-d1.md.
 *
 * Co-scoping (ADR-0018 / ADR-0027): every table carries `app_id`; the
 * per-Environment CONFIGURATION tables (flag_configs, targeting_rules) also carry
 * `environment_id`. The Flag DEFINITION (flags, variants) is App-level only.
 *
 * SEAM-ENFORCED REFERENCES (not DB FKs): default_variant_id (on flags and
 * flag_configs) and targeting_rules.variant_id are plain text. They point at
 * variants, whose flag_id points back at flags — a cycle a single SQLite migration
 * cannot FK. Their referential integrity is enforced in the data-access seam
 * (ADR-0018), not by a SQLite foreign key. SPL-11 must not assume DB enforcement.
 */

export const flags = sqliteTable(
  "flags",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // JSON Schema (nullable): value contract Variant `value`s must satisfy.
    schema: text("schema"),
    defaultVariantId: text("default_variant_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: userRef("created_by"),
    updatedBy: userRef("updated_by"),
    // Optimistic-lock counter.
    version: integer("version").notNull().default(1),
  },
  (t) => [uniqueIndex("flags_app_key_unique").on(t.appId, t.key)],
);

export const variants = sqliteTable("variants", {
  id: text("id").primaryKey(),
  flagId: text("flag_id")
    .notNull()
    .references(() => flags.id),
  name: text("name").notNull(),
  // JSON-serialized Variant value.
  value: text("value").notNull(),
  description: text("description"),
  createdAt: createdAt(),
});

export const flagConfigs = sqliteTable(
  "flag_configs",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    // Co-scoped with app_id (ADR-0027).
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    flagId: text("flag_id")
      .notNull()
      .references(() => flags.id),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    // JSON string array; subset of the Flag's Variant catalog.
    availableVariantNames: text("available_variant_names").notNull(),
    defaultVariantId: text("default_variant_id"),
    // JSON PercentageRollout (nullable): the baseline rollout for traffic that
    // matches no Targeting Rule. Its salt is minted once server-side and never
    // regenerated on a percentage change, so buckets stay stable (ADR-0036).
    rollout: text("rollout"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer("version").notNull().default(1),
  },
  (t) => [uniqueIndex("flag_configs_flag_env_unique").on(t.flagId, t.environmentId)],
);

export const targetingRules = sqliteTable("targeting_rules", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id),
  // Co-scoped with app_id (ADR-0027).
  environmentId: text("environment_id")
    .notNull()
    .references(() => environments.id),
  flagId: text("flag_id")
    .notNull()
    .references(() => flags.id),
  priority: integer("priority").notNull(),
  // JSON array of Condition.
  conditions: text("conditions").notNull(),
  variantId: text("variant_id"),
  // JSON PercentageRollout (nullable).
  percentageRollout: text("percentage_rollout"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const segments = sqliteTable("segments", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id),
  name: text("name").notNull(),
  // JSON array of Condition.
  conditions: text("conditions").notNull(),
  description: text("description"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
