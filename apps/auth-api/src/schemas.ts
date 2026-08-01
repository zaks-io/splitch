import { z } from "zod";

/**
 * Request body schemas for the auth-door endpoints. Kept apart from the route
 * wiring so the shapes are testable in isolation and the handler files stay
 * focused on flow, not parsing.
 */

/**
 * POST /agent/identity (Door B anonymous): NO `id_jag`; a Turnstile token gates
 * the write (ADR-0034). The presence/absence of `id_jag` is what routes the
 * request to Door A vs Door B (auth-doors.md: "with no `id_jag` field").
 */
export const AnonymousIdentityRequestSchema = z.object({
  turnstile_token: z.string().min(1),
});

/**
 * POST /agent/identity/claim (and POST /claim): the claim ceremony body.
 *
 * Two-step: an INITIATE call carries only {identity_assertion, email} (no otp) and
 * either triggers an OTP send or returns durable collision consent state; a VERIFY
 * call adds {otp, idempotency_key} for OTP or {verification_id, idempotency_key}
 * after consent. `email` is only shape-validated here
 * (min length); the canonical validation + normalization is single-sourced in
 * email.ts so the same canonical string feeds the OTP binding, the collision
 * lookup, and the verify-email write (they can never disagree).
 */
export const ClaimRequestSchema = z.object({
  identity_assertion: z.string().min(1),
  email: z.string().min(1),
  resource: z.url().optional(),
  otp: z.string().min(1).optional(),
  verification_id: z.string().min(1).optional(),
  idempotency_key: z.string().min(1).optional(),
});

export const ClaimConsentRequestSchema = z.object({
  decision: z.enum(["approve", "deny"]),
});

/** POST /oauth2/token: token-exchange of an identity_assertion. */
export const TokenExchangeRequestSchema = z.object({
  grant_type: z.string(),
  identity_assertion: z.string().min(1),
  resource: z.url().optional(),
});

/** POST /oauth2/device_authorization: starts Door C's device-code flow. */
/**
 * Cold-start contract: `app` and `scope` are both optional. A login with no
 * App yet mints an unbound session, which is exactly what `orgs list` /
 * `orgs create` need (docs/spec/quickstart.md step 1).
 */
export const DeviceAuthorizationRequestSchema = z.object({
  client_id: z.string().min(1),
  app: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
});

/** POST /oauth2/token: Door C device-code polling grant. */
export const DeviceTokenRequestSchema = z.object({
  grant_type: z.string(),
  device_code: z.string().min(1),
  client_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  resource: z.url().optional(),
});

/**
 * POST /oauth2/token: rotates a Door C provider refresh token. `app` / `org`
 * rebind the minted access token to another resource the user's live
 * membership allows — one human approval, many rebinds; `splitch use` is a
 * rescope, never a re-login. At most one of the two may be present.
 */
export const RefreshTokenRequestSchema = z
  .object({
    grant_type: z.string(),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1).optional(),
    resource: z.url().optional(),
    app: z.string().min(1).optional(),
    org: z.string().min(1).optional(),
  })
  .refine((value) => value.app === undefined || value.org === undefined);

/** POST /oauth2/token: shared-preview smoke client_credentials grant. */
export const ClientCredentialsRequestSchema = z.object({
  grant_type: z.string(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  scope: z.string().min(1).optional(),
  resource: z.url().optional(),
});

/** POST /oauth2/revoke: RFC 7009 token revocation. */
export const RevokeTokenRequestSchema = z.object({
  token: z.string().min(1),
  token_type_hint: z.string().min(1).optional(),
});

/** POST /orgs/:orgId/trusted-idps body (Org-owner CRUD). */
export const CreateTrustedIdpRequestSchema = z.object({
  issuer: z.string().min(1),
  jwks_uri: z.string().min(1),
  client_ids: z.array(z.string()).min(1),
  enabled: z.boolean().optional(),
});
