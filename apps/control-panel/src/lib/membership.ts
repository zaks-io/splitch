import { appScope, type Repository } from "@splitch/db";
import type { EnvironmentResolver } from "./loader-context";
import {
  refreshSession,
  type AppMembership,
  type AppRole,
  type OrgMembership,
  type OrgRole,
  type StoredSession,
} from "./session";

export interface SessionPrincipalInput {
  userId: string;
  workosSessionId: string;
}

export async function buildSessionPrincipal(
  repo: Repository,
  input: SessionPrincipalInput,
): Promise<Omit<StoredSession, "expiresAt">> {
  const orgMembershipRows = await repo.identity.listOrgMembershipsForUser(input.userId);
  const orgs: Array<OrgMembership> = [];
  const orgSlugs = new Set<string>();

  for (const orgMembership of orgMembershipRows) {
    const org = await repo.identity.getOrg(orgMembership.orgId);
    if (!org) {
      throw new Error("Organization membership references a missing Organization");
    }

    const orgSlug = organizationSlug(org.name, org.id);
    if (orgSlugs.has(orgSlug)) {
      throw new Error("duplicate organization URL handle for authenticated user");
    }
    orgSlugs.add(orgSlug);

    const apps = await repo.identity.listAppsForOrg(org.id);
    const appMemberships: Array<AppMembership> = [];
    for (const app of apps) {
      const membership = await repo.identity.getAppMembership(appScope(app.id), input.userId);
      if (!membership) {
        continue;
      }
      appMemberships.push({
        appId: app.id,
        appSlug: app.key,
        role: appRole(membership.role),
      });
    }

    orgs.push({
      orgId: org.id,
      orgSlug,
      orgRole: orgRole(orgMembership.role),
      isProvisional: org.isProvisional,
      demoExpiresAt: org.demoExpiresAt,
      apps: appMemberships,
    });
  }

  return {
    userId: input.userId,
    workosSessionId: input.workosSessionId,
    orgs,
  };
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
    workosAccessToken: session.workosAccessToken,
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

/**
 * Current D1 Organizations have no persisted URL handle. Until the schema grows
 * one, session materialization derives the handle from the Organization name;
 * renames intentionally invalidate stale URLs, and collisions fail loud above.
 */
export function organizationSlug(name: string, orgId: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || orgId;
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
