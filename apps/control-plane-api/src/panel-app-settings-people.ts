import type { AppMember } from "@splitch/contracts";
import { UserRoleSchema } from "@splitch/contracts";
import type { PanelAppAccessCandidate } from "@splitch/control-plane-sdk/panel-app-settings";
import type { Repository } from "@splitch/db";
import type { MemberProfileResolver } from "./org-handlers";

type AppMembershipRow = Awaited<ReturnType<Repository["identity"]["listAppMembers"]>>[number];

interface PeopleDeps {
  repo: Repository;
  memberProfileResolver?: MemberProfileResolver;
}

/**
 * The two people-shaped halves of App Settings: who has access, and who in the
 * owning Organization could be given it.
 *
 * `email` is null when the identity cache holds no profile for that user yet. A
 * placeholder address would be a silent default for missing data (ADR-0036), so
 * the absence is modelled and the screen renders it as an absence.
 */
export async function appAccessPeople(
  deps: PeopleDeps,
  input: {
    canGrantAccess: boolean;
    canListCandidates: boolean;
    orgId: string;
    memberships: readonly AppMembershipRow[];
    request: Request;
  },
): Promise<{
  members: AppMember[];
  candidates: PanelAppAccessCandidate[] | undefined;
  candidatesWithheld: boolean;
}> {
  const members: AppMember[] = [];
  for (const membership of input.memberships) {
    members.push({
      appId: membership.appId,
      userId: membership.userId,
      email: await resolveEmail(deps, input, membership.userId),
      role: UserRoleSchema.parse(membership.role),
      createdAt: membership.createdAt,
    });
  }

  if (!input.canGrantAccess) {
    return { members, candidates: undefined, candidatesWithheld: false };
  }
  // A granting viewer without roster access must not see an empty array: that
  // reads as "everyone already has access", which is a different fact (ADR-0036).
  if (!input.canListCandidates) {
    return { members, candidates: undefined, candidatesWithheld: true };
  }

  const orgMemberships = await deps.repo.identity.listOrgMemberships(input.orgId);
  const hasAppAccess = new Set(input.memberships.map((membership) => membership.userId));

  const candidates: PanelAppAccessCandidate[] = [];
  for (const orgMembership of orgMemberships) {
    if (hasAppAccess.has(orgMembership.userId)) continue;
    candidates.push({
      userId: orgMembership.userId,
      email: await resolveEmail(deps, input, orgMembership.userId),
      orgRole: UserRoleSchema.parse(orgMembership.role),
    });
  }

  return { members, candidates, candidatesWithheld: false };
}

async function resolveEmail(
  deps: PeopleDeps,
  input: { orgId: string; request: Request },
  userId: string,
): Promise<string | null> {
  const profile = await deps.memberProfileResolver?.({
    orgId: input.orgId,
    userId,
    request: input.request,
  });
  return profile?.email ?? null;
}
