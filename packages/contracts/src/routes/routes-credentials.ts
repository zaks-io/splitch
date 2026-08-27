import {
  CreateCredentialResponseSchema,
  ListCredentialsResponseSchema,
} from "../resource-envelopes-account";
import { ClientKeySchema } from "../leaf-schemas-runtime";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  ApiKeyParams,
  ApiKeyRevokeResponseSchema,
  ClientKeyRotateResponseSchema,
  CreateApiKeyRequestSchema,
  EnvParams,
  PatchClientKeyRequestSchema,
  RevokeApiKeyRequestSchema,
} from "./route-shapes";

/**
 * SDK credential management (Client Key + API Key), per-Environment (ADR-0027).
 * Control Plane API Worker. Client Keys are auto-provisioned, so there is no
 * client-key create route — only get/update/rotate. API Keys are minted on demand.
 * Endpoint canon: docs/spec/control-plane/endpoints-credentials.md.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

export const credentialRoutes = [
  defineApiRoute({
    operationId: "client_key_get",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/envs/:environmentId/client-key",
    summary: "Get the Environment's public Client Key (never 404s for a live Env).",
    request: { params: EnvParams },
    response: ClientKeySchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "client_key_update",
    owner: OWNER,
    method: "PATCH",
    path: "/apps/:appId/envs/:environmentId/client-key",
    summary: "Update the Client Key's origin allow-list / rate limit.",
    request: { params: EnvParams, body: PatchClientKeyRequestSchema },
    response: ClientKeySchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["CREDENTIAL_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "client_key_rotate",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/envs/:environmentId/client-key/revoke",
    summary: "Revoke the current Client Key and create its replacement.",
    request: { params: EnvParams },
    response: ClientKeyRotateResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["CREDENTIAL_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "api_keys_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/envs/:environmentId/api-keys",
    summary: "List API Key metadata (no secrets; bounded; reports its own truncation).",
    request: { params: EnvParams },
    response: ListCredentialsResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "api_keys_create",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/envs/:environmentId/api-keys",
    summary: "Mint an API Key (raw secret surfaced once only).",
    request: { params: EnvParams, body: CreateApiKeyRequestSchema },
    response: CreateCredentialResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "optional",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "api_keys_revoke",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/envs/:environmentId/api-keys/:keyId/revoke",
    summary: "Revoke an API Key.",
    request: { params: ApiKeyParams, body: RevokeApiKeyRequestSchema },
    response: ApiKeyRevokeResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["CREDENTIAL_NOT_FOUND", "FORBIDDEN"],
  }),
] as const satisfies readonly ApiRouteContract[];
