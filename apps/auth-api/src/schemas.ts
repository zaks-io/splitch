import { z } from "zod";

/**
 * Request body schemas for the auth-door endpoints. Kept apart from the route
 * wiring so the shapes are testable in isolation and the handler files stay
 * focused on flow, not parsing.
 */

/** POST /agent/identity (ID-JAG door): a signed JWT + optional requested scopes. */
export const AgentIdentityRequestSchema = z.object({
  id_jag: z.string().min(1),
  requested_scopes: z.array(z.string()).optional(),
});

/** POST /oauth2/token: token-exchange of an identity_assertion. */
export const TokenExchangeRequestSchema = z.object({
  grant_type: z.string(),
  identity_assertion: z.string().min(1),
});

/** POST /orgs/:orgId/trusted-idps body (Org-owner CRUD). */
export const CreateTrustedIdpRequestSchema = z.object({
  issuer: z.string().min(1),
  jwks_uri: z.string().min(1),
  client_ids: z.array(z.string()).min(1),
  enabled: z.boolean().optional(),
});
