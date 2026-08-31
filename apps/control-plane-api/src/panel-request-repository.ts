import type { createRepository } from "@splitch/db";

type Repository = ReturnType<typeof createRepository>;

export function repositoryForPanelRequest(
  repo: Repository,
  protocol: "none" | "signed" | "bounded-session",
  method: string,
): Repository {
  return protocol === "signed" && method === "GET" ? memoizePanelIdentityReads(repo) : repo;
}

/**
 * A signed Panel GET authenticates and serves the read with the same repository.
 * Keep identical identity reads on one promise so the handler's fail-closed
 * recheck remains in place without paying a second D1 round trip.
 */
export function memoizePanelIdentityReads(repo: Repository): Repository {
  return {
    ...repo,
    identity: {
      ...repo.identity,
      getApp: memoizeCall(repo.identity.getApp),
      getAppMembership: memoizeCall(repo.identity.getAppMembership),
      getEnvironment: memoizeCall(repo.identity.getEnvironment),
      getOrgMembership: memoizeCall(repo.identity.getOrgMembership),
      getOrgMembershipForApp: memoizeCall(repo.identity.getOrgMembershipForApp),
    },
  };
}

function memoizeCall<TArgs extends readonly unknown[], TResult>(
  call: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const results = new Map<string, TResult>();
  return (...args) => {
    const key = JSON.stringify(args);
    const existing = results.get(key);
    if (existing !== undefined) return existing;
    const result = call(...args);
    results.set(key, result);
    return result;
  };
}
