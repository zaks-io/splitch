import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt, userRef } from "./columns";

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

const DEFAULT_ENVIRONMENT_POLICY = JSON.stringify({
  variantAvailability: "allow",
  targetingRolloutValue: "allow",
  enabledState: "allow",
  startExperimentRun: "allow",
});

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
  // Set only by the atomic Door B transfer acquisition batch.
  claimAcquiredAt: text("claim_acquired_at"),
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
    policy: text("policy").notNull().default(DEFAULT_ENVIRONMENT_POLICY),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: userRef("created_by"),
  },
  (t) => [uniqueIndex("environments_app_key_unique").on(t.appId, t.key)],
);

export const deviceRefreshSessions = sqliteTable("device_refresh_sessions", {
  refreshTokenHash: text("refresh_token_hash").primaryKey(),
  providerSessionId: text("provider_session_id").notNull(),
  createdAt: createdAt(),
});

/**
 * Bounded Door B workflow state. Identifiers are SHA-256 digests, never raw
 * email addresses, WorkOS user ids, OTPs, or session tokens.
 */
export const claimVerifications = sqliteTable("claim_verifications", {
  id: text("id").primaryKey(),
  provisionalUserHash: text("provisional_user_hash").notNull(),
  emailHash: text("email_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  verifiedAt: text("verified_at"),
  consumedAt: text("consumed_at"),
  createdAt: createdAt(),
});

export const claimConsentAttempts = sqliteTable("claim_consent_attempts", {
  id: text("id").primaryKey(),
  verificationId: text("verification_id")
    .notNull()
    .references(() => claimVerifications.id),
  existingUserHash: text("existing_user_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  approvedAt: text("approved_at"),
  consumedAt: text("consumed_at"),
  createdAt: createdAt(),
});

export const claimIdempotency = sqliteTable("claim_idempotency", {
  keyHash: text("key_hash").primaryKey(),
  verificationId: text("verification_id")
    .notNull()
    .references(() => claimVerifications.id),
  provisionalUserHash: text("provisional_user_hash").notNull(),
  emailHash: text("email_hash").notNull(),
  completedAt: text("completed_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

/**
 * Trusted IdP allow-list for ID-JAG validation (access-control-matrix.md). Org
 * owner CRUD only; unknown `issuer` fails loud as `unknown_issuer`. `enabled = 0`
 * IdPs are rejected, never silently skipped.
 *
 * `org_id` is the tenancy boundary (access-control-matrix.md:53-55):
 *  - NULL  → a splitch-INTERNAL GLOBAL seed (Anthropic/OpenAI/Cursor), trusted
 *    platform-wide, seeded at deploy, NOT user-mutable through the CRUD path.
 *  - non-NULL → a TENANT's OWN IdP, owned by exactly that Org. A tenant may only
 *    list/delete its own rows; it can never see, mutate, or delete a global seed
 *    or another tenant's IdP.
 *
 * Collapsing both into one flat global table is the cross-tenant impersonation
 * vector this column closes: a tenant-registered issuer must never be honored for
 * a victim in a different tenant. Issuer is unique PER scope (one tenant's custom
 * issuer cannot shadow another's or a global seed), so the uniqueness index keys
 * on (org_id, issuer), not issuer alone.
 */
export const trustedIdps = sqliteTable(
  "trusted_idps",
  {
    idpId: text("idp_id").primaryKey(),
    // NULL = splitch-internal global seed; non-NULL = this tenant's own IdP.
    orgId: text("org_id"),
    issuer: text("issuer").notNull(),
    jwksUri: text("jwks_uri").notNull(),
    // JSON string array of expected `aud` values (client IDs for this IdP).
    clientIds: text("client_ids").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("trusted_idps_org_issuer_unique").on(t.orgId, t.issuer)],
);
