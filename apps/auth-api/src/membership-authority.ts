import { appScope, type Repository } from "@splitch/db";
import { OAuthError } from "./oauth-errors";

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
    getOrg(orgId: string): PromiseLike<{ id: string; slug: string | null } | null>;
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

/**
 * Extract the App selector from a legacy device-grant scope request
 * (`app:<selector>:<role>`). The role segment is accepted for wire
 * compatibility but ignored: since the cold-start redesign the role in a
 * minted scope always comes from live membership, never from the request.
 */
export function parseSelectedAppRequest(scope: string | undefined): { selector: string } {
  const requested = parseRequestedScopes(scope);
  const parsed = requested?.length === 1 ? parseMembershipScope(requested[0] as string) : null;
  if (parsed?.kind !== "app") {
    throw new OAuthError("invalid_request", "device grant requires one canonical App scope");
  }
  return { selector: parsed.id };
}

/**
 * Resolve an App selector (ID or slug) to a live app-bound scope, searching
 * the user's own Org memberships. Authority derives from live D1 membership
 * keyed by userId — never from a WorkOS Organization grant, which personal
 * AuthKit sign-ins do not have.
 */
export async function resolveAppSelectionForUser(
  repo: MembershipAuthorityRepo,
  userId: string,
  selector: string,
): Promise<{ appId: string; scope: string }> {
  const orgMemberships = await repo.identity.listOrgMembershipsForUser(userId);
  const reachable: App[] = [];
  for (const orgMembership of orgMemberships) {
    reachable.push(...(await repo.identity.listAppsForOrg(orgMembership.orgId)));
  }
  const selectedApp = selectReachableApp(reachable, selector);
  const membership = await repo.identity.getAppMembership(appScope(selectedApp.id), userId);
  if (!membership) {
    throw new OAuthError("invalid_grant", "selected App is not authorized by live membership");
  }
  return { appId: selectedApp.id, scope: scopeFor("app", selectedApp.id, membership.role) };
}

/**
 * Two passes, in this order, over every App the user can reach:
 *
 * 1. canonical ID, which is globally unique, so a hit is unambiguous;
 * 2. App key, which `apps_org_key_unique` only makes unique *per Org*.
 *
 * The order matters for tenant isolation. Anyone can add a user to their own
 * Org, so a per-Org key pass that ran first would let an attacker key an App
 * `app_<victimAppId>` and capture a victim's binding by winning enumeration
 * order. A key that matches more than one App is refused rather than
 * arbitrated by row order: picking one would be a disguised default.
 */
function selectReachableApp(reachable: readonly App[], selector: string): App {
  const byId = reachable.find((app) => app.id === selector);
  if (byId) return byId;
  const byKey = reachable.filter((app) => app.key === selector);
  const [selectedApp, ambiguous] = byKey;
  if (!selectedApp) {
    throw new OAuthError("invalid_grant", "selected App is not reachable by live membership");
  }
  if (ambiguous) {
    throw new OAuthError(
      "invalid_grant",
      `App selector "${selector}" matches more than one App across your Organizations; pass the canonical App ID`,
    );
  }
  return selectedApp;
}

/**
 * Resolve an Organization selector (ID or slug) to a live org-bound scope
 * from the user's own memberships.
 */
export async function resolveOrgSelectionForUser(
  repo: MembershipAuthorityRepo,
  userId: string,
  selector: string,
): Promise<{ orgId: string; scope: string }> {
  const orgMemberships = await repo.identity.listOrgMembershipsForUser(userId);
  const byId = orgMemberships.find((membership) => membership.orgId === selector);
  if (byId) return { orgId: byId.orgId, scope: scopeFor("org", byId.orgId, byId.role) };
  for (const membership of orgMemberships) {
    const org = await repo.identity.getOrg(membership.orgId);
    if (org?.slug === selector) {
      return { orgId: membership.orgId, scope: scopeFor("org", membership.orgId, membership.role) };
    }
  }
  throw new OAuthError(
    "invalid_grant",
    "selected Organization is not reachable by live membership",
  );
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
