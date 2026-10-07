import { z } from "@hono/zod-openapi";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  CreatePersonalAccessTokenRequestSchema,
  PersonalAccessTokenIdSchema,
  PersonalAccessTokenSchema,
  PersonalAccessTokenSecretResponseSchema,
  RevokeAllPersonalAccessTokensResponseSchema,
  UpdatePersonalAccessTokenRequestSchema,
} from "../personal-access-tokens";
import {
  deleteClosed,
  mintSecretClosed,
  readOnlyClosed,
  rotateClosed,
  updateClosed,
} from "../route-effects";
import { listResponse } from "../wire-envelopes-core";

/**
 * Personal Access Token management (ADR-0022, 2026-10-03 amendment). Every
 * route is keyed by the calling user, never by a path Organization or App.
 *
 * These are CLI-only: `public-bearer` exposure keeps them off every service
 * binding (MCP and panel), and they are excluded from MCP tool derivation, so
 * an MCP credential can never mint, widen, or extend a PAT.
 * Endpoint canon: docs/spec/control-plane/personal-access-tokens.md.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;
const EXPOSURE = "public-bearer" as const;
const TOKEN_ERRORS = ["CREDENTIAL_NOT_FOUND", "FORBIDDEN"] as const;

const TokenParams = z.object({ tokenId: PersonalAccessTokenIdSchema });

export const personalAccessTokenOperationIds = [
  "personal_access_tokens_list",
  "personal_access_tokens_create",
  "personal_access_tokens_update",
  "personal_access_tokens_rotate",
  "personal_access_tokens_revoke",
  "personal_access_tokens_revoke_all",
] as const;

export const personalAccessTokenRoutes = [
  defineApiRoute({
    operationId: "personal_access_tokens_list",
    owner: OWNER,
    method: "GET",
    path: "/personal-access-tokens",
    summary: "List your Personal Access Tokens (metadata only; secrets are never returned).",
    response: listResponse(PersonalAccessTokenSchema),
    exposure: EXPOSURE,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    effects: readOnlyClosed,
    errors: ["FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "personal_access_tokens_create",
    owner: OWNER,
    method: "POST",
    path: "/personal-access-tokens",
    summary: "Create a Personal Access Token for the MCP server (secret surfaced once only).",
    request: { body: CreatePersonalAccessTokenRequestSchema },
    response: PersonalAccessTokenSecretResponseSchema,
    exposure: EXPOSURE,
    auth: AUTH,
    rateLimit: RATE,
    // A once-only raw secret cannot be replayed without retaining it.
    idempotency: "none",
    effects: mintSecretClosed,
    errors: ["FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "personal_access_tokens_update",
    owner: OWNER,
    method: "PATCH",
    path: "/personal-access-tokens/:tokenId",
    summary: "Rename a Personal Access Token or replace its grants or expiry.",
    request: { params: TokenParams, body: UpdatePersonalAccessTokenRequestSchema },
    response: PersonalAccessTokenSchema,
    exposure: EXPOSURE,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    effects: updateClosed,
    errors: [...TOKEN_ERRORS, "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "personal_access_tokens_rotate",
    owner: OWNER,
    method: "POST",
    path: "/personal-access-tokens/:tokenId/rotate",
    summary: "Replace a Personal Access Token's secret; the old secret stops working.",
    request: { params: TokenParams },
    response: PersonalAccessTokenSecretResponseSchema,
    exposure: EXPOSURE,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    effects: rotateClosed,
    errors: [...TOKEN_ERRORS],
  }),
  defineApiRoute({
    operationId: "personal_access_tokens_revoke",
    owner: OWNER,
    method: "POST",
    path: "/personal-access-tokens/:tokenId/revoke",
    summary: "Revoke a Personal Access Token.",
    request: { params: TokenParams },
    response: PersonalAccessTokenSchema,
    exposure: EXPOSURE,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    effects: deleteClosed,
    errors: [...TOKEN_ERRORS],
  }),
  defineApiRoute({
    operationId: "personal_access_tokens_revoke_all",
    owner: OWNER,
    method: "POST",
    path: "/personal-access-tokens/revoke-all",
    summary: "Revoke every active Personal Access Token you own.",
    response: RevokeAllPersonalAccessTokensResponseSchema,
    exposure: EXPOSURE,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    effects: deleteClosed,
    errors: ["FORBIDDEN"],
  }),
] as const satisfies readonly ApiRouteContract[];
