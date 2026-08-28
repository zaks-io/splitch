import { type UserRole, userRoles } from "./leaf-schemas-runtime";

export const MAX_HELD_SCOPE_COUNT = 64;
export const MAX_HELD_SCOPE_LENGTH = 512;

const heldScopeRoles = new Set<UserRole>(userRoles);

/** A canonical Organization or App membership scope carried by an access token. */
export function isCanonicalHeldScope(scope: unknown): scope is string {
  if (typeof scope !== "string" || scope.length === 0 || scope.length > MAX_HELD_SCOPE_LENGTH) {
    return false;
  }
  const segments = scope.split(":");
  if (segments.length !== 3) return false;
  const [kind, id, role] = segments;
  return (kind === "org" || kind === "app") && id !== "" && heldScopeRoles.has(role as UserRole);
}

/** The bounded canonical membership-scope claim shared by Auth and MCP. */
export function isCanonicalHeldScopes(scopes: unknown): scopes is string[] {
  return (
    Array.isArray(scopes) &&
    scopes.length <= MAX_HELD_SCOPE_COUNT &&
    scopes.every(isCanonicalHeldScope)
  );
}
