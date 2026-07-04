import type { ErrorResponse, RouteContract } from "@splitch/contracts";
import type { RegistrarDeps } from "../deps";
import { type Principal, PUBLIC_PRINCIPAL } from "../principal";

export type ResolveOutcome =
  | { ok: true; principal: Principal }
  | { ok: false; error: ErrorResponse };

/**
 * Step 3. Dispatch principal resolution by the route's auth kind. Public routes
 * resolve to the sentinel principal. The resolver presence is guaranteed by the
 * boot-time assertResolvable check; a missing one here is still treated as a
 * loud fault rather than a silent allow.
 */
export async function resolvePrincipal(
  contract: RouteContract,
  deps: RegistrarDeps,
  request: Request,
): Promise<ResolveOutcome> {
  if (contract.auth === "public") {
    return { ok: true, principal: PUBLIC_PRINCIPAL };
  }

  const resolver = deps.authResolvers[contract.auth];
  if (!resolver) {
    throw new Error(`worker-runtime: no auth resolver for kind "${contract.auth}" at request time`);
  }

  const result = await resolver(request);
  if (result.ok) {
    return { ok: true, principal: result.principal };
  }
  if (result.error !== undefined) {
    return { ok: false, error: result.error };
  }

  return {
    ok: false,
    error: { code: result.reason, message: reasonMessage(result.reason), details: {} },
  };
}

function reasonMessage(reason: "UNAUTHORIZED" | "CREDENTIAL_REVOKED"): string {
  return reason === "UNAUTHORIZED" ? "no valid credential" : "credential is revoked";
}
