import { z } from "@hono/zod-openapi";
import { userRoles } from "./leaf-schemas-runtime";

export const MAX_HELD_SCOPE_COUNT = 64;
export const MAX_HELD_SCOPE_LENGTH = 512;

const HELD_SCOPE_PATTERN = new RegExp(`^(?:org|app):[^:]+:(?:${userRoles.join("|")})$`);

/** One bounded Organization or App membership scope. */
export const HeldScopeSchema = z.string().max(MAX_HELD_SCOPE_LENGTH).regex(HELD_SCOPE_PATTERN);

/** A canonical Organization or App membership scope carried by an access token. */
export function isCanonicalHeldScope(scope: unknown): scope is string {
  return HeldScopeSchema.safeParse(scope).success;
}

/** The bounded canonical membership-scope claim shared by Auth and MCP. */
export function isCanonicalHeldScopes(scopes: unknown): scopes is string[] {
  return (
    Array.isArray(scopes) &&
    scopes.length <= MAX_HELD_SCOPE_COUNT &&
    scopes.every(isCanonicalHeldScope)
  );
}
