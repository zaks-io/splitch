import type { Organization } from "@splitch/contracts";
import type { Repository } from "@splitch/db";

type OrgRow = NonNullable<Awaited<ReturnType<Repository["identity"]["getOrg"]>>>;

/**
 * The single Organization wire projection, shared by list/get/update/create.
 *
 * It exists as one function because it is a whitelist: the D1 row carries claim
 * tokens, Stripe ids, and the provisional-reaper columns, none of which belong
 * on the wire. A second copy of this mapping is a second place for one of those
 * to be added by accident.
 */
export function organizationResponse(org: OrgRow): Organization {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan as Organization["plan"],
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}
