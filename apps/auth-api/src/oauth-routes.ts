import type { Hono } from "hono";
import { DEVICE_CODE_GRANT, type DeviceFlowPort } from "./device-flow.js";
import { OAuthError, renderOAuthError } from "./oauth-errors.js";
import type { RevocationStore } from "./revocation.js";
import {
  DeviceAuthorizationRequestSchema,
  DeviceTokenRequestSchema,
  RevokeTokenRequestSchema,
  TokenExchangeRequestSchema,
} from "./schemas.js";
import type { TokenSigner } from "./token-exchange.js";
import { verifyAccessToken } from "./access-token.js";

const ACCESS_TOKEN_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

export interface OAuthRouteDeps {
  tokenSigner: TokenSigner;
  deviceFlow: DeviceFlowPort;
  revocations: RevocationStore;
  accessSecret: string;
  controlPlaneAudience: string;
  now: () => number;
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
    return Response.json({
      issuer,
      token_endpoint: `${issuer}/oauth2/token`,
      revocation_endpoint: `${issuer}/oauth2/revoke`,
      device_authorization_endpoint: `${issuer}/oauth2/device_authorization`,
      grant_types_supported: [ACCESS_TOKEN_GRANT, DEVICE_CODE_GRANT],
      token_endpoint_auth_methods_supported: ["none"],
      agent_auth: {
        skill: `${issuer}/auth.md`,
        identity_endpoint: `${issuer}/agent/identity`,
        claim_endpoint: `${issuer}/agent/identity/claim`,
        identity_types_supported: ["id_jag", "anonymous", "device_flow"],
      },
    });
  });

  app.get("/auth.md", (c) => {
    const issuer = new URL(c.req.raw.url).origin;
    return new Response(authMarkdown(issuer), {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  });

  app.post("/oauth2/device_authorization", async (c) => {
    const parsed = DeviceAuthorizationRequestSchema.safeParse(await readBody(c.req.raw));
    if (!parsed.success) {
      return renderOAuthError(
        new OAuthError("invalid_request", "malformed /oauth2/device_authorization body"),
      );
    }
    try {
      return Response.json(await deps.deviceFlow.authorizeDevice(parsed.data));
    } catch (cause) {
      return renderDoorFault(cause);
    }
  });

  app.post("/oauth2/token", async (c) => {
    const body = await readBody(c.req.raw);
    const grantType = grantTypeOf(body);
    if (grantType === ACCESS_TOKEN_GRANT) {
      return exchangeIdentityAssertion(deps, body, nowSeconds());
    }
    if (grantType === DEVICE_CODE_GRANT) {
      return exchangeDeviceCode(deps, body, nowSeconds());
    }
    if (grantType) {
      return renderOAuthError(
        new OAuthError("unsupported_grant_type", `grant_type "${grantType}" not supported`),
      );
    }
    return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/token body"));
  });

  app.post("/oauth2/revoke", async (c) => {
    const parsed = RevokeTokenRequestSchema.safeParse(await readBody(c.req.raw));
    if (!parsed.success) {
      return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/revoke body"));
    }

    try {
      const actor = await verifyAccessToken(
        `Bearer ${parsed.data.token}`,
        { accessSecret: deps.accessSecret, controlPlaneAudience: deps.controlPlaneAudience },
        nowSeconds(),
      );
      if (actor) {
        await deps.revocations.revoke(actor.userId, actor.expiresAt - nowSeconds());
      } else {
        await deps.deviceFlow.revokeProviderToken(parsed.data.token);
      }
    } catch (cause) {
      return renderDoorFault(cause);
    }

    return new Response(null, { status: 200 });
  });
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
    );
    return tokenResponse(accessToken);
  } catch (cause) {
    return renderDoorFault(cause);
  }
}

async function exchangeDeviceCode(
  deps: OAuthRouteDeps,
  body: unknown,
  nowSeconds: number,
): Promise<Response> {
  const parsed = DeviceTokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return renderOAuthError(new OAuthError("invalid_request", "malformed /oauth2/token body"));
  }
  try {
    const deviceToken = await deps.deviceFlow.exchangeDeviceCode({
      clientId: parsed.data.client_id,
      deviceCode: parsed.data.device_code,
      scope: parsed.data.scope,
    });
    const accessToken = await deps.tokenSigner.mintAccessToken(
      deviceToken.userId,
      deviceToken.scopes,
      "device_flow",
      nowSeconds,
    );
    return tokenResponse(accessToken, deviceToken.refreshToken);
  } catch (cause) {
    return renderDoorFault(cause);
  }
}

function tokenResponse(accessToken: string, refreshToken?: string): Response {
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  });
}

function authMarkdown(issuer: string): string {
  return `# splitch auth

Use one of the supported auth doors, then exchange the resulting credential at ${issuer}/oauth2/token.

- ID-JAG or anonymous: POST ${issuer}/agent/identity
- Claim ceremony: POST ${issuer}/agent/identity/claim
- Device flow: POST ${issuer}/oauth2/device_authorization, then poll ${issuer}/oauth2/token with the device_code grant
- Revoke: POST ${issuer}/oauth2/revoke
`;
}

async function readBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(await request.text()));
  }
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function grantTypeOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("grant_type" in body)) {
    return undefined;
  }
  const grantType = (body as { grant_type?: unknown }).grant_type;
  return typeof grantType === "string" ? grantType : undefined;
}

function renderDoorFault(cause: unknown): Response {
  if (cause instanceof OAuthError) {
    return renderOAuthError(cause);
  }
  return renderOAuthError(new OAuthError("server_error", "auth door fault"));
}
