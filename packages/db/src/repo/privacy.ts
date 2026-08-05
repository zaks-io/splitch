import { and, eq, isNull } from "drizzle-orm";
import { entityDeletions, privacyRequests, trustedIdps } from "../schema/index";
import type { Db } from "./client";
import type { TenantScope } from "./scope";
import { scopedTable } from "./scoped-table";

/**
 * Privacy + IdP-allow-list repository.
 *
 * Scoping regimes (ADR-0018):
 *  - APP-SCOPED: entity_deletions (the analysis-exclusion tombstone ledger
 *    carries `app_id`) routes through the scope-bound helper.
 *  - ORG/IDENTITY-SCOPED: privacy_requests is an ORG-level ledger (`org_id` not
 *    null, `app_id` nullable for org-wide requests), so it is NOT app-scoped;
 *    forcing app_id would hide org-wide requests. Scoped by org_id, optionally
 *    narrowed to an app.
 *  - TWO-TIER (trusted_idps): a tenancy-scoped allow-list. `org_id IS NULL` rows
 *    are splitch-internal GLOBAL seeds (Anthropic/OpenAI/Cursor), trusted
 *    platform-wide and NOT user-mutable through CRUD; `org_id = ?` rows are a
 *    tenant's OWN IdPs. The CRUD methods are org-scoped (a tenant sees/deletes
 *    only its own rows); the ID-JAG issuer lookup is GLOBAL-SEED-ONLY (see its
 *    method comment) so a tenant-registered issuer can never be honored for a
 *    victim in another tenant (access-control-matrix.md:53-55).
 */
export function makePrivacyRepo(db: Db) {
  const entityDeletionsTable = scopedTable(db, entityDeletions);

  return {
    entityDeletions: entityDeletionsTable,

    listEntityDeletions(scope: TenantScope) {
      return entityDeletionsTable.findMany(scope);
    },

    // --- Org-scoped privacy ledger (NOT app-scoped) ----------------------------

    listPrivacyRequestsForOrg(orgId: string) {
      return db.select().from(privacyRequests).where(eq(privacyRequests.orgId, orgId));
    },

    listPrivacyRequestsForApp(orgId: string, appId: string) {
      return db
        .select()
        .from(privacyRequests)
        .where(and(eq(privacyRequests.orgId, orgId), eq(privacyRequests.appId, appId)));
    },

    /**
     * Cascade helper for App teardown (`--force`). Entity tombstones have no
     * public delete API; force removes the App's ledger rows after gated
     * children are cleared (SPL-326).
     */
    async deleteEntityDeletionsForApp(scope: TenantScope): Promise<number> {
      const rows = await db
        .delete(entityDeletions)
        .where(eq(entityDeletions.appId, scope.appId))
        .returning();
      return rows.length;
    },

    /**
     * Cascade helper for App teardown (`--force`). Removes App-scoped privacy
     * request rows; org-wide requests (`app_id` null) are untouched.
     */
    async deletePrivacyRequestsForApp(orgId: string, appId: string): Promise<number> {
      const rows = await db
        .delete(privacyRequests)
        .where(and(eq(privacyRequests.orgId, orgId), eq(privacyRequests.appId, appId)))
        .returning();
      return rows.length;
    },

    async getPrivacyRequest(
      orgId: string,
      requestId: string,
    ): Promise<typeof privacyRequests.$inferSelect | null> {
      const rows = await db
        .select()
        .from(privacyRequests)
        .where(and(eq(privacyRequests.orgId, orgId), eq(privacyRequests.requestId, requestId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async getPrivacyRequestById(
      requestId: string,
    ): Promise<typeof privacyRequests.$inferSelect | null> {
      const rows = await db
        .select()
        .from(privacyRequests)
        .where(eq(privacyRequests.requestId, requestId))
        .limit(1);
      return rows[0] ?? null;
    },

    // --- Trusted IdP allow-list (two-tier: global seeds + per-tenant) ----------

    /**
     * ID-JAG issuer lookup. Scoped to GLOBAL SEEDS ONLY (`org_id IS NULL`).
     *
     * WHY global-seed-only and not also per-org: the `/agent/identity` request
     * body carries `{ id_jag, requested_scopes? }` and NO org context
     * (auth-doors.md:24-31) — the user/org is resolved AFTER verification, from
     * the WorkOS user. With no org bound at lookup time, honoring a tenant's
     * custom issuer here is exactly the cross-tenant impersonation vector: org_b
     * could register `attacker.evil` and have it accepted for a victim. So a
     * tenant's custom IdP is STORED (org_id set) but not yet resolvable through
     * this door; only the deploy-seeded global issuers are honored platform-wide.
     * Per-org custom issuer resolution waits until the door carries an org context
     * to bind `issuer = ? AND org_id = ?` safely (access-control-matrix.md:53-55).
     */
    async getTrustedIdpByIssuer(issuer: string): Promise<typeof trustedIdps.$inferSelect | null> {
      const rows = await db
        .select()
        .from(trustedIdps)
        .where(and(eq(trustedIdps.issuer, issuer), isNull(trustedIdps.orgId)))
        .limit(1);
      return rows[0] ?? null;
    },

    /** List a tenant's OWN IdPs only — never the global seeds, never another tenant's. */
    listTrustedIdps(orgId: string): Promise<(typeof trustedIdps.$inferSelect)[]> {
      return db.select().from(trustedIdps).where(eq(trustedIdps.orgId, orgId));
    },

    /** Create a tenant IdP. The caller's authz'd orgId is stamped by the CRUD layer. */
    async createTrustedIdp(
      values: typeof trustedIdps.$inferInsert,
    ): Promise<typeof trustedIdps.$inferSelect> {
      const rows = await db.insert(trustedIdps).values(values).returning();
      const inserted = rows[0];
      if (!inserted) {
        throw new Error("createTrustedIdp: no row returned");
      }
      return inserted;
    },

    /**
     * Delete a tenant's OWN IdP. Bound by BOTH org_id AND idp_id so a tenant can
     * never delete a global seed (org_id NULL fails the `= ?` match) nor another
     * tenant's row. Returns the deleted count so the caller can 404 a no-op
     * (which surfaces a cross-tenant delete attempt rather than lying success).
     */
    async deleteTrustedIdp(orgId: string, idpId: string): Promise<number> {
      const rows = await db
        .delete(trustedIdps)
        .where(and(eq(trustedIdps.orgId, orgId), eq(trustedIdps.idpId, idpId)))
        .returning();
      return rows.length;
    },
  };
}
