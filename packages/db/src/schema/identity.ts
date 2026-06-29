import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt, userRef } from "./columns.js";

/**
 * Identity-domain D1 tables: Organization tier, memberships, Apps, Environments,
 * and the trusted-IdP allow-list.
 * Source of truth: docs/spec/contracts/storage-schemas-d1.md plus the
 * billing-seam / provisional columns in
 * docs/spec/control-plane/organization-and-membership.md and the trusted_idps
 * shape in docs/spec/control-plane/access-control-matrix.md.
 *
 * No table has RLS: `app_id` (tenant) / `org_id` (org) scoping is enforced in the
 * Worker data-access seam (ADR-0018). These columns exist from day one so that
 * seam can always filter on them.
 */

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  // Billing seam: shape exists, live Stripe integration deferred. Nullable.
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  // 0|1. Enterprise SSO wired via WorkOS.
  ssoEnabled: integer("sso_enabled", { mode: "boolean" }).notNull().default(false),
  // Provisional-org reaper: true while created by the anon door, not yet claimed.
  // is_provisional = 1 implies demo_expires_at IS NOT NULL (enforced in the seam).
  isProvisional: integer("is_provisional", { mode: "boolean" }).notNull().default(false),
  demoExpiresAt: text("demo_expires_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const orgMemberships = sqliteTable(
  "org_memberships",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const apps = sqliteTable(
  "apps",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    key: text("key").notNull(),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: userRef("created_by"),
  },
  (t) => [uniqueIndex("apps_org_key_unique").on(t.organizationId, t.key)],
);

export const appMemberships = sqliteTable(
  "app_memberships",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.userId] })],
);

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: userRef("created_by"),
  },
  (t) => [uniqueIndex("environments_app_key_unique").on(t.appId, t.key)],
);

/**
 * Trusted IdP allow-list for ID-JAG validation (access-control-matrix.md). Org
 * owner CRUD only; unknown `issuer` fails loud as `unknown_issuer`. `enabled = 0`
 * IdPs are rejected, never silently skipped.
 */
export const trustedIdps = sqliteTable(
  "trusted_idps",
  {
    idpId: text("idp_id").primaryKey(),
    issuer: text("issuer").notNull(),
    jwksUri: text("jwks_uri").notNull(),
    // JSON string array of expected `aud` values (client IDs for this IdP).
    clientIds: text("client_ids").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("trusted_idps_issuer_unique").on(t.issuer)],
);
