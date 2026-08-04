import { z } from "zod";

/**
 * Canonical API Key scope vocabulary for the data plane.
 * Source: docs/spec/control-plane/credentials-and-keys.md § Scope format.
 *
 * Create requests must enumerate only these values. Granular scopes are future
 * work — do not invent synonyms here.
 */
export const apiKeyScopes = ["data-plane:evaluate", "data-plane:write"] as const;

export const ApiKeyScopeSchema = z.enum(apiKeyScopes, {
  error: () => `allowed scopes: ${apiKeyScopes.join(", ")}`,
});
