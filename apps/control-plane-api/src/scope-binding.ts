/**
 * Derive a Principal's App binding from control-plane token scopes.
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
 * Environment binding: the token scope shape carries no `env:` axis (ADR-0027:
 * the control-plane token is App-scoped, Environment co-scope is enforced from
 * the path against the App membership, not a token env claim), so
 * `environmentId` is always null here. The co-scope step then leaves the
 * `:environmentId` path axis to membership/handler checks, never a false bind.
 */

export interface ScopeBinding {
  appId: string | null;
  environmentId: string | null;
}

const APP_SCOPE = /^app:([^:]+):(owner|admin|member)$/;

/** The distinct App ids named across a token's app-scopes. */
function appIdsInScopes(scopes: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const scope of scopes) {
    const match = APP_SCOPE.exec(scope);
    if (match) {
      ids.add(match[1] as string);
    }
  }
  return ids;
}

export function deriveBinding(scopes: readonly string[]): ScopeBinding {
  const appIds = appIdsInScopes(scopes);
  // Exactly one App named → bound to it. Zero (org token) or many (multi-App
  // token) → unbound on the App axis (co-scope FORBIDs app-scoped routes).
  const appId = appIds.size === 1 ? ([...appIds][0] as string) : null;
  return { appId, environmentId: null };
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
