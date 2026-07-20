import { appScope, type Repository } from "@splitch/db";

type MembershipRole = "owner" | "admin" | "member";
const ROLE_RANK: Record<MembershipRole, number> = { member: 1, admin: 2, owner: 3 };
const MEMBERSHIP_SCOPE = /^(org|app):([^:]+):(owner|admin|member)$/;
type IdentityRepo = Repository["identity"];
type OrgMembership = Awaited<ReturnType<IdentityRepo["listOrgMembershipsForUser"]>>[number];
type App = Awaited<ReturnType<IdentityRepo["listAppsForOrg"]>>[number];
type AppMembership = Awaited<ReturnType<IdentityRepo["getAppMembership"]>>;

export interface MembershipAuthorityRepo {
  identity: {
    listOrgMembershipsForUser(userId: string): PromiseLike<OrgMembership[]>;
    listAppsForOrg(orgId: string): PromiseLike<App[]>;
    getAppMembership(
      scope: ReturnType<typeof appScope>,
      userId: string,
    ): PromiseLike<AppMembership>;
  };
}

export async function resolveMembershipAuthority(
  repo: MembershipAuthorityRepo,
  userId: string,
): Promise<string[]> {
  const scopes: string[] = [];
  const orgMemberships = await repo.identity.listOrgMembershipsForUser(userId);

  for (const orgMembership of orgMemberships) {
    scopes.push(scopeFor("org", orgMembership.orgId, orgMembership.role));
    const apps = await repo.identity.listAppsForOrg(orgMembership.orgId);
    for (const app of apps) {
      const membership = await repo.identity.getAppMembership(appScope(app.id), userId);
      if (membership) {
        scopes.push(scopeFor("app", app.id, membership.role));
      }
    }
  }

  return scopes.sort();
}

export function narrowMembershipAuthority(
  authority: readonly string[],
  ...requestedScopeSets: Array<readonly string[] | undefined>
): string[] {
  const constraints = requestedScopeSets.filter(
    (requested): requested is readonly string[] => requested !== undefined,
  );
  return authority.flatMap((scope) => {
    const narrowed = narrowScope(scope, constraints);
    return narrowed ? [narrowed] : [];
  });
}

export function parseRequestedScopes(scope: string | undefined): string[] | undefined {
  return scope === undefined ? undefined : scope.trim().split(/\s+/).filter(Boolean);
}

function scopeFor(kind: "org" | "app", id: string, role: string): string {
  if (!isMembershipRole(role)) {
    throw new Error(`unsupported ${kind} membership role`);
  }
  return `${kind}:${id}:${role}`;
}

function isMembershipRole(role: string): role is MembershipRole {
  return role === "owner" || role === "admin" || role === "member";
}

function parseMembershipScope(
  scope: string,
): { kind: "org" | "app"; id: string; role: MembershipRole } | null {
  const match = MEMBERSHIP_SCOPE.exec(scope);
  if (!match) return null;
  return {
    kind: match[1] as "org" | "app",
    id: match[2] as string,
    role: match[3] as MembershipRole,
  };
}

function highestRequestedRole(
  requested: readonly string[],
  kind: "org" | "app",
  id: string,
): MembershipRole | null {
  let highest: MembershipRole | null = null;
  for (const scope of requested) {
    const parsed = parseMembershipScope(scope);
    if (
      parsed?.kind === kind &&
      parsed.id === id &&
      (!highest || ROLE_RANK[parsed.role] > ROLE_RANK[highest])
    ) {
      highest = parsed.role;
    }
  }
  return highest;
}

function narrowScope(scope: string, constraints: readonly (readonly string[])[]): string | null {
  const live = parseMembershipScope(scope);
  if (!live) throw new Error("unsupported live membership scope");
  let role = live.role;
  for (const requested of constraints) {
    const requestedRole = highestRequestedRole(requested, live.kind, live.id);
    if (!requestedRole) return null;
    role = ROLE_RANK[requestedRole] < ROLE_RANK[role] ? requestedRole : role;
  }
  return `${live.kind}:${live.id}:${role}`;
}
