import { timingSafeEqualString } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { verifyAccessToken } from "./access-token";
import { accessTokenJwks } from "./access-token-key";
import { authMarkdown } from "./auth-markdown";
import { DEVICE_CODE_GRANT, type DeviceFlowPort, REFRESH_TOKEN_GRANT } from "./device-flow";
import {
  authorizeDevice,
  exchangeDeviceCode,
  exchangeRefreshToken,
  requireFirstPartyClient,
} from "./device-oauth";
import type { DeviceRefreshSessionStore } from "./device-session-store";
import type { MembershipAuthorityRepo } from "./membership-authority";
import { OAuthError, renderDoorFault, renderOAuthError } from "./oauth-errors";
import { readOAuthRequestBody, renderAuthBodyError } from "./read-request-body";
import type { RevocationStore } from "./revocation";
import {
  ClientCredentialsRequestSchema,
  RevokeTokenRequestSchema,
  TokenExchangeRequestSchema,
} from "./schemas";
import type { TokenSigner } from "./token-exchange";

const ACCESS_TOKEN_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const CLIENT_CREDENTIALS_GRANT = "client_credentials";

export interface SmokeClientCredentials {
  clientId: string;
  clientSecret: string;
  userId: string;
  scopes: string[];
}

export interface OAuthRouteDeps {
  tokenSigner: TokenSigner;
  deviceFlow: DeviceFlowPort;
  deviceRefreshSessions: DeviceRefreshSessionStore;
  /** Shared SESSION_STORE for member-profile writes at device login/refresh. */
  sessionStore: KVNamespace;
  revocations: RevocationStore;
  accessSecret: string;
  controlPlaneAudience: string;
  mcpAudience?: string;
  smokeClientCredentials?: SmokeClientCredentials;
  now: () => number;
  repo: MembershipAuthorityRepo;
}

export function mountOAuthRoutes(app: Hono, deps: OAuthRouteDeps): void {
  const nowSeconds = () => Math.floor(deps.now() / 1000);

  app.get("/.well-known/oauth-protected-resource", (c) => {
    const issuer = new URL(c.req.raw.url).origin;
    return Response.json({
      resource: deps.controlPlaneAudience,
      authorization_servers: [issuer],
    });
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const issuer = new URL(c.req.raw.url).origin;
    const smokeEnabled = deps.smokeClientCredentials !== undefined;
    return Response.json({
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      token_endpoint: `${issuer}/oauth2/token`,
      revocation_endpoint: `${issuer}/oauth2/revoke`,
      device_authorization_endpoint: `${issuer}/oauth2/device_authorization`,
      grant_types_supported: [
        ACCESS_TOKEN_GRANT,
        DEVICE_CODE_GRANT,
        REFRESH_TOKEN_GRANT,
        ...(smokeEnabled ? [CLIENT_CREDENTIALS_GRANT] : []),
      ],
      token_endpoint_auth_methods_supported: [
        "none",
        ...(smokeEnabled ? ["client_secret_post"] : []),
      ],
      agent_auth: {
        skill: `${issuer}/auth.md`,
        identity_endpoint: `${issuer}/agent/identity`,
        claim_endpoint: `${issuer}/agent/identity/claim`,
        identity_types_supported: ["anonymous", "device_flow"],
      },
    });
  });

  app.get("/.well-known/jwks.json", () => {
    const jwks = accessTokenJwks(deps.accessSecret);
    if (!jwks) {
      return Response.json({ error: "access-token JWKS is not configured" }, { status: 500 });
    }
    return Response.json(jwks);
  });

  app.get("/auth.md", (c) => {
    const issuer = new URL(c.req.raw.url).origin;
    return new Response(authMarkdown(issuer, Boolean(deps.smokeClientCredentials)), {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  });

  app.post("/oauth2/device_authorization", async (c) => {
    const body = await readOAuthRequestBody(c.req.raw);
    if (!body.ok) return renderAuthBodyError(body.reason);
    return authorizeDevice(deps, body.value);
  });

  app.post("/oauth2/token", async (c) => {
    const body = await readOAuthRequestBody(c.req.raw);
    if (!body.ok) return renderAuthBodyError(body.reason);
    return handleTokenRequest(deps, body.value, nowSeconds());
  });

  app.post("/oauth2/revoke", async (c) => {
    const body = await readOAuthRequestBody(c.req.raw);
    if (!body.ok) return renderAuthBodyError(body.reason);
    return revokeToken(deps, body.value, nowSeconds());
  });
}

async function revokeToken(
  deps: OAuthRouteDeps,
  body: unknown,
  nowSeconds: number,
): Promise<Response> {
  const parsed = RevokeTokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/revoke body"));
  }

  try {
    // Every other OAuth endpoint identifies its caller; revoke is the one
    // that destroys authority, so it holds the same first-party gate.
    requireFirstPartyClient(parsed.data.client_id);
    const actor = await verifyRevocableAccessToken(deps, parsed.data.token, nowSeconds);
    if (actor) {
      await deps.revocations.revoke(actor.userId, actor.expiresAt - nowSeconds);
    } else {
      const session = await deps.deviceRefreshSessions.lookup(parsed.data.token);
      if (!session) {
        throw new OAuthError("invalid_grant", "refresh token session is unknown");
      }
      await deps.deviceFlow.revokeProviderToken({
        token: parsed.data.token,
        sessionId: session.providerSessionId,
      });
      await deps.deviceRefreshSessions.forget(parsed.data.token);
    }
  } catch (cause) {
    return renderDoorFault(cause);
  }

  return new Response(null, { status: 200 });
}

function handleTokenRequest(
  deps: OAuthRouteDeps,
  body: unknown,
  nowSeconds: number,
): Response | Promise<Response> {
  const grantType = grantTypeOf(body);
  const resolveAudience = (resource: string | undefined) => audienceForResource(deps, resource);
  if (grantType === ACCESS_TOKEN_GRANT) {
    return exchangeIdentityAssertion(deps, body, nowSeconds);
  }
  if (grantType === DEVICE_CODE_GRANT) {
    return exchangeDeviceCode(deps, body, nowSeconds, resolveAudience);
  }
  if (grantType === REFRESH_TOKEN_GRANT) {
    return exchangeRefreshToken(deps, body, nowSeconds, resolveAudience);
  }
  if (grantType === CLIENT_CREDENTIALS_GRANT && deps.smokeClientCredentials) {
    return exchangeClientCredentials(deps, body, nowSeconds);
  }
  if (grantType) {
    return renderOAuthError(
      new OAuthError("unsupported_grant_type", `grant_type "${grantType}" not supported`),
    );
  }
  return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/token body"));
}

async function exchangeClientCredentials(
  deps: OAuthRouteDeps,
  body: unknown,
  nowSeconds: number,
): Promise<Response> {
  const parsed = ClientCredentialsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/token body"));
  }
  const client = deps.smokeClientCredentials;
  if (!client) {
    return renderOAuthError(
      new OAuthError(
        "unsupported_grant_type",
        `grant_type "${CLIENT_CREDENTIALS_GRANT}" not supported`,
      ),
    );
  }
  if (parsed.data.client_id !== client.clientId) {
    return renderOAuthError(new OAuthError("invalid_client", "client credentials are invalid"));
  }
  if (!(await timingSafeEqualString(parsed.data.client_secret, client.clientSecret))) {
    return renderOAuthError(new OAuthError("invalid_client", "client credentials are invalid"));
  }

  const requestedScopes = parsed.data.scope?.split(/\s+/).filter(Boolean) ?? [];
  const scopes = requestedScopes.length > 0 ? requestedScopes : client.scopes;
  if (scopes.some((scope) => !client.scopes.includes(scope))) {
    return renderOAuthError(new OAuthError("invalid_request", "requested scope is not allowed"));
  }

  try {
    const accessToken = await deps.tokenSigner.mintAccessToken(
      client.userId,
      scopes,
      "client_credentials",
      nowSeconds,
      audienceForResource(deps, parsed.data.resource),
    );
    return tokenResponse(accessToken);
  } catch (cause) {
    return renderDoorFault(cause);
  }
}

async function exchangeIdentityAssertion(
  deps: OAuthRouteDeps,
  body: unknown,
  nowSeconds: number,
): Promise<Response> {
  const parsed = TokenExchangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/token body"));
  }
  try {
    const accessToken = await deps.tokenSigner.exchangeForAccessToken(
      parsed.data.identity_assertion,
      nowSeconds,
      audienceForResource(deps, parsed.data.resource),
    );
    return tokenResponse(accessToken);
  } catch (cause) {
    return renderDoorFault(cause);
  }
}

export function audienceForResource(
  deps: Pick<OAuthRouteDeps, "controlPlaneAudience" | "mcpAudience">,
  resource: string | undefined,
): string {
  if (!resource) return deps.controlPlaneAudience;
  if (allowedAccessTokenAudiences(deps).includes(resource)) return resource;
  throw new OAuthError("invalid_request", "requested resource is not supported");
}

function allowedAccessTokenAudiences(
  deps: Pick<OAuthRouteDeps, "controlPlaneAudience" | "mcpAudience">,
): string[] {
  if (!deps.mcpAudience) return [deps.controlPlaneAudience];
  const mcpRoot = deps.mcpAudience.replace(/\/+$/, "");
  return [deps.controlPlaneAudience, mcpRoot, `${mcpRoot}/mcp`];
}

async function verifyRevocableAccessToken(deps: OAuthRouteDeps, token: string, nowSeconds: number) {
  for (const audience of allowedAccessTokenAudiences(deps)) {
    const actor = await verifyAccessToken(
      `Bearer ${token}`,
      { accessSecret: deps.accessSecret, controlPlaneAudience: audience },
      nowSeconds,
    );
    if (actor) return actor;
  }
  return null;
}

function tokenResponse(accessToken: string, refreshToken?: string): Response {
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  });
}

function grantTypeOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("grant_type" in body)) {
    return undefined;
  }
  const grantType = (body as { grant_type?: unknown }).grant_type;
  return typeof grantType === "string" ? grantType : undefined;
}
