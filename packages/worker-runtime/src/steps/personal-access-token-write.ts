import { type ErrorResponse, getRoute, type RouteContract } from "@splitch/contracts";
import { scopeBinding } from "../mcp-delegation-auth";
import type { Principal } from "../principal";

export type NarrowOutcome =
  | { ok: true; principal: Principal }
  | { ok: false; error: ErrorResponse };

/**
 * Step 5b. A Personal Access Token's grants may be read-only for some or all
 * targets. On an operation whose audited effects mutate, the principal is
 * narrowed to the token's write scopes BEFORE selector binding, co-scope, and
 * the handler's role checks, so every downstream gate sees write authority
 * only. A mutation with no Organization or App in its path (e.g. creating an
 * Organization) needs a read-write `all` grant.
 *
 * Effects come from the audited route registry, never the HTTP method: a POST
 * that writes nothing stays readable. An operation missing from the registry is
 * treated as mutating (fail closed).
 */
export function narrowPersonalAccessTokenForRoute(
  contract: RouteContract,
  principal: Principal,
  params: Record<string, string>,
): NarrowOutcome {
  const token = principal.personalAccessToken;
  if (!token) return { ok: true, principal };
  if (getRoute(contract.id)?.effects.mutates === false) return { ok: true, principal };

  const targeted = /:(orgId|appId)\b/.test(contract.path);
  if (!targeted && !token.writeAll) {
    return refuse("personal access token needs a read-write `all` grant for this operation");
  }
  const readOnlyTarget = canonicalTarget(params);
  if (readOnlyTarget && !token.writeScopes.some((scope) => scope.startsWith(readOnlyTarget))) {
    return refuse(
      `personal access token grants read-only access to ${readOnlyTarget.slice(0, -1)}`,
    );
  }
  return {
    ok: true,
    principal: {
      ...principal,
      scopes: token.writeScopes,
      ...scopeBinding(token.writeScopes),
    },
  };
}

/**
 * The canonical `app:<id>:`/`org:<id>:` prefix the path names, when it names one
 * by id. A slug is left to selector resolution and co-scope, which still refuse
 * it against the narrowed write scopes.
 */
function canonicalTarget(params: Record<string, string>): string | null {
  if (params.appId?.startsWith("app_")) return `app:${params.appId}:`;
  if (params.orgId?.startsWith("org_")) return `org:${params.orgId}:`;
  return null;
}

function refuse(message: string): NarrowOutcome {
  return { ok: false, error: { code: "FORBIDDEN", message, details: {} } };
}
