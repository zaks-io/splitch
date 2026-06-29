import { and, eq } from "drizzle-orm";
import { entityDeletions, privacyRequests, trustedIdps } from "../schema/index.js";
import type { Db } from "./client.js";
import type { TenantScope } from "./scope.js";
import { scopedTable } from "./scoped-table.js";

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
 *  - GLOBAL: trusted_idps is an Org-owner-managed allow-list keyed by issuer;
 *    it has no tenant column and is read by issuer (ID-JAG validation).
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

    // --- Global IdP allow-list -------------------------------------------------

    async getTrustedIdpByIssuer(issuer: string): Promise<typeof trustedIdps.$inferSelect | null> {
      const rows = await db
        .select()
        .from(trustedIdps)
        .where(eq(trustedIdps.issuer, issuer))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
