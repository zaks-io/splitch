import { appScope, type Repository } from "@splitch/db";
import type { EnvironmentResolver } from "./loader-context";
import {
  type AppMembership,
  type AppRole,
  type OrgMembership,
  type OrgRole,
  refreshSession,
  type StoredSession,
  serverOnlySessionFields,
} from "./session";

export interface SessionPrincipalInput {
  userId: string;
  workosSessionId: string;
}

/**
 * The most Organizations a session snapshot will ever hold.
 *
 * A session principal must not scale with membership count. The snapshot is
 * rebuilt on every create and written whole into a single KV value, so an
 * uncapped list lets a User grow their own session until it can no longer be
 * materialized, which locks them out of their own account with no way back.
 * Exceeding the cap is reported, never hidden: `orgsTruncated` rides along and
 * the chooser says so out loud.
 */
export const SESSION_ORG_LIMIT = 50;

/**
 * Materializes the session snapshot in a FLAT number of D1 queries: one for the
 * Organizations, one for the Apps across all of them. Deliberately not "the same
 * loop but concurrent" — concurrency would still issue 2N+1 subrequests per
 * invocation and hit the same Workers ceiling, just sooner.
 */
export async function buildSessionPrincipal(
  repo: Repository,
  input: SessionPrincipalInput,
): Promise<Omit<StoredSession, "expiresAt">> {
  // One row past the cap, so truncation is observed rather than assumed.
  const rows = await repo.identity.listOrgMembershipsWithOrgForUser(
    input.userId,
    SESSION_ORG_LIMIT + 1,
  );
  const orgsTruncated = rows.length > SESSION_ORG_LIMIT;
  const kept = orgsTruncated ? rows.slice(0, SESSION_ORG_LIMIT) : rows;

  const orgSlugs = new Set<string>();
  for (const row of kept) {
    if (!row.org) {
      throw new Error("Organization membership references a missing Organization");
    }
    // The persisted handle, not a derived one: it is unique by index, so a
    // duplicate here means the DB invariant broke and must not be papered over.
    if (orgSlugs.has(row.org.slug)) {
      throw new Error("duplicate organization URL handle for authenticated user");
    }
    orgSlugs.add(row.org.slug);
  }

  const appsByOrg = await appMembershipsByOrg(repo, input.userId, kept);
  const orgs: Array<OrgMembership> = kept.map((row) => {
    const org = row.org as NonNullable<typeof row.org>;
    return {
      orgId: org.id,
      orgSlug: org.slug,
      orgRole: orgRole(row.role),
      isProvisional: org.isProvisional,
      demoExpiresAt: org.demoExpiresAt,
      apps: appsByOrg.get(org.id) ?? [],
    };
  });

  return {
    userId: input.userId,
    workosSessionId: input.workosSessionId,
    orgs,
    orgsTruncated,
  };
}

type OrgMembershipRow = Awaited<
  ReturnType<Repository["identity"]["listOrgMembershipsWithOrgForUser"]>
>[number];

async function appMembershipsByOrg(
  repo: Repository,
  userId: string,
  rows: readonly OrgMembershipRow[],
): Promise<Map<string, Array<AppMembership>>> {
  const orgIds = rows.flatMap((row) => (row.org ? [row.org.id] : []));
  const appRows = await repo.identity.listAppMembershipsWithAppForUser(userId, orgIds);
  const byOrg = new Map<string, Array<AppMembership>>();
  for (const row of appRows) {
    const bucket = byOrg.get(row.app.organizationId) ?? [];
    bucket.push({ appId: row.app.id, appSlug: row.app.key, role: appRole(row.role) });
    byOrg.set(row.app.organizationId, bucket);
  }
  return byOrg;
}

/** Upgrade v1 sessions from D1 instead of treating a new membership field as a global logout. */
export async function rehydrateLegacySession(
  repo: Repository,
  kv: KVNamespace,
  tokenHash: string,
  session: StoredSession,
): Promise<StoredSession> {
  if (session.version !== 1) {
    return session;
  }
  if (!session.workosSessionId) {
    throw new Error("legacy control-panel session is missing its WorkOS session identifier");
  }
  const principal = await buildSessionPrincipal(repo, {
    userId: session.userId,
    workosSessionId: session.workosSessionId,
  });
  const rehydrated: StoredSession = {
    ...principal,
    expiresAt: session.expiresAt,
    ...serverOnlySessionFields(session),
  };
  await refreshSession(kv, tokenHash, rehydrated);
  return { ...rehydrated, version: 2 };
}

export function createEnvironmentResolver(repo: Repository): EnvironmentResolver {
  return {
    async listEnvironments(appId) {
      const environments = await repo.identity.listEnvironments(appScope(appId));
      return environments.map((environment) => ({
        environmentId: environment.id,
        env: environment.key,
        name: environment.name,
      }));
    },
  };
}

function orgRole(role: string): OrgRole {
  if (role === "owner" || role === "admin" || role === "member") {
    return role;
  }
  throw new Error("unknown Organization role in session materialization");
}

function appRole(role: string): AppRole {
  if (role === "owner" || role === "admin" || role === "member" || role === "viewer") {
    return role;
  }
  throw new Error("unknown App role in session materialization");
}
