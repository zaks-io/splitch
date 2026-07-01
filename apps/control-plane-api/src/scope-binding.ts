/**
 * Derive a Principal's Org and App binding from control-plane token scopes.
 *
 * Scope format (access-control-matrix.md): `app:{app_id}:{role}` and
 * `org:{org_id}:{role}`, role ∈ {owner, admin, member}. A token may carry MANY
 * App scopes (a user who is admin on two Apps). The Principal's `appId` is the
 * single App the credential is bound to for the co-scope check; it is meaningful
 * only when the token names exactly one App. When the token names zero Apps (an
 * org-level token) or more than one, `appId` is null: an org/multi-App token is
 * not bound to a single App, so the guard's co-scope step FORBIDs it from an
 * app-scoped route (it never silently picks one).
 *
 * Org binding mirrors the App axis: `orgId` is the single Org the credential is
 * bound to, meaningful only when the token names exactly one Org (the agent-first
 * provisional Org). Zero or many Org scopes → `orgId` null, and the co-scope step
 * FORBIDs the org-scoped route rather than silently picking one.
 *
 * Environment binding: the token scope shape carries no `env:` axis (ADR-0027:
 * the control-plane token is App-scoped, Environment co-scope is enforced from
 * the path against the App membership, not a token env claim), so
 * `environmentId` is always null here. The co-scope step then leaves the
 * `:environmentId` path axis to membership/handler checks, never a false bind.
 */

export interface ScopeBinding {
  orgId: string | null;
  appId: string | null;
  environmentId: string | null;
}

const APP_SCOPE = /^app:([^:]+):(owner|admin|member)$/;
const ORG_SCOPE = /^org:([^:]+):(owner|admin|member)$/;

/** The distinct ids named across the scopes matching `pattern`'s first group. */
function idsInScopes(scopes: readonly string[], pattern: RegExp): Set<string> {
  const ids = new Set<string>();
  for (const scope of scopes) {
    const match = pattern.exec(scope);
    if (match) {
      ids.add(match[1] as string);
    }
  }
  return ids;
}

/** Exactly one id named → bound to it. Zero or many → unbound (null). */
function soleId(ids: Set<string>): string | null {
  return ids.size === 1 ? ([...ids][0] as string) : null;
}

export function deriveBinding(scopes: readonly string[]): ScopeBinding {
  return {
    orgId: soleId(idsInScopes(scopes, ORG_SCOPE)),
    appId: soleId(idsInScopes(scopes, APP_SCOPE)),
    environmentId: null,
  };
}

/**
 * Required scope to WRITE an App (access-control-matrix.md: an App mutation needs
 * the `admin` role on that App). The single authoring point for the App-write
 * role gate; the owning Worker layers it onto the write route's `scopes` so the
 * registrar's generic scope step enforces it.
 */
export function appAdminScope(appId: string): string {
  return `app:${appId}:admin`;
}
