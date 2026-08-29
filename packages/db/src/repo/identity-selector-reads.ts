import { and, asc, eq, inArray, or } from "drizzle-orm";
import { appMemberships, apps, environments, organizations, orgMemberships } from "../schema/index";
import type { Db } from "./client";
import { twoColumnIdBatches } from "./id-batches";
import type { TenantScope } from "./scope";

export interface AppSelectorCandidate {
  orgSlug: string;
  appId: string;
  appSlug: string;
}

export interface EnvironmentSelectorCandidate {
  environmentId: string;
  environmentKey: string;
}

/** Resolve an App key only through both of the caller's live membership axes. */
export function makeIdentitySelectorReads(db: Db) {
  return {
    findAppSelectorCandidatesForUser(
      userId: string,
      appKey: string,
    ): Promise<AppSelectorCandidate[]> {
      return db
        .select({
          orgSlug: organizations.slug,
          appId: apps.id,
          appSlug: apps.key,
        })
        .from(orgMemberships)
        .innerJoin(apps, and(eq(apps.organizationId, orgMemberships.orgId), eq(apps.key, appKey)))
        .innerJoin(
          appMemberships,
          and(eq(appMemberships.appId, apps.id), eq(appMemberships.userId, userId)),
        )
        .innerJoin(organizations, eq(organizations.id, apps.organizationId))
        .where(eq(orgMemberships.userId, userId))
        .orderBy(asc(organizations.slug), asc(apps.id));
    },

    findEnvironmentSelectorCandidates(
      scope: TenantScope,
      selector: string,
    ): Promise<EnvironmentSelectorCandidate[]> {
      return db
        .select({
          environmentId: environments.id,
          environmentKey: environments.key,
        })
        .from(environments)
        .where(
          and(
            eq(environments.appId, scope.appId),
            or(eq(environments.id, selector), eq(environments.key, selector)),
          ),
        )
        .orderBy(asc(environments.id));
    },

    /**
     * Batched because D1 caps bound parameters per statement; see
     * `twoColumnIdBatches` — each selector binds on both `id` and `key`.
     */
    async findEnvironmentSelectorCandidatesForSelectors(
      scope: TenantScope,
      selectors: readonly string[],
    ): Promise<EnvironmentSelectorCandidate[]> {
      const batches = await Promise.all(
        twoColumnIdBatches(selectors).map((batch) =>
          db
            .select({
              environmentId: environments.id,
              environmentKey: environments.key,
            })
            .from(environments)
            .where(
              and(
                eq(environments.appId, scope.appId),
                or(inArray(environments.id, [...batch]), inArray(environments.key, [...batch])),
              ),
            )
            .orderBy(asc(environments.id)),
        ),
      );
      return batches.flat();
    },
  };
}
