import { rememberMemberProfile } from "@splitch/contracts";
import { createRepository, type Repository } from "@splitch/db";
import { WorkOS } from "@workos-inc/node/worker";
import type { ControlPanelBindings } from "./bindings";
import { buildSessionPrincipal } from "./membership";
import { createSession } from "./session";

export interface AuthKitClient {
  getAuthorizationUrl(options: { clientId: string; redirectUri: string; state: string }): string;
  authenticateWithCode(options: {
    clientId: string;
    code: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AuthKitAuthentication>;
  getLogoutUrl(options: { sessionId: string; returnTo: string }): string;
}

interface AuthKitAuthentication {
  user: { id: string; email: string; emailVerified: boolean };
  accessToken: string;
}

export interface CompleteAuthKitCallbackInput {
  authKit: AuthKitClient;
  clientId: string;
  code: string;
  kv: KVNamespace;
  repo: Repository;
  request: Request;
  now?: number;
}

export function createAuthKitClient(bindings: ControlPanelBindings): AuthKitClient {
  const workos = new WorkOS({
    apiKey: bindings.WORKOS_API_KEY,
    clientId: bindings.WORKOS_CLIENT_ID,
  });

  return {
    getAuthorizationUrl({ clientId, redirectUri, state }) {
      return workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId,
        redirectUri,
        state,
      });
    },
    async authenticateWithCode({ clientId, code, ipAddress, userAgent }) {
      const response = await workos.userManagement.authenticateWithCode({
        clientId,
        code,
        ipAddress,
        userAgent,
      });
      return {
        user: {
          id: response.user.id,
          email: response.user.email,
          emailVerified: response.user.emailVerified,
        },
        accessToken: response.accessToken,
      };
    },
    getLogoutUrl({ sessionId, returnTo }) {
      return workos.userManagement.getLogoutUrl({ sessionId, returnTo });
    },
  };
}

export function createControlPanelRepository(bindings: ControlPanelBindings): Repository {
  return createRepository(bindings.DB);
}

export async function completeAuthKitCallback(input: CompleteAuthKitCallbackInput): Promise<{
  cookie: string;
}> {
  const authentication = await input.authKit.authenticateWithCode({
    clientId: input.clientId,
    code: input.code,
    ipAddress: requestIp(input.request),
    userAgent: input.request.headers.get("user-agent") ?? undefined,
  });

  const accessClaims = decodeWorkOsAccessTokenClaims(authentication.accessToken);
  const sessionPrincipal = await buildSessionPrincipal(input.repo, {
    userId: authentication.user.id,
    workosSessionId: accessClaims.sessionId,
  });

  // Same gate as ID-JAG / device flow: only a verified address may enter the
  // member-profile identity cache (spoofable display identity otherwise).
  if (!authentication.user.email || authentication.user.emailVerified !== true) {
    throw new Error(
      "WorkOS AuthKit callback returned a user without a verified email; verify the email address before signing in",
    );
  }
  await rememberMemberProfile(input.kv, authentication.user.id, authentication.user.email);

  const session = await createSession(
    input.kv,
    {
      ...sessionPrincipal,
      expiresAt: accessClaims.expiresAt,
      workosAccessToken: authentication.accessToken,
    },
    input.now,
  );
  return { cookie: session.cookie };
}

export function callbackRedirectUri(request: Request): string {
  return new URL("/auth/callback", request.url).toString();
}

function decodeWorkOsAccessTokenClaims(accessToken: string): {
  sessionId: string;
  expiresAt: number;
} {
  const payload = decodeJwtPayload(accessToken);
  const sid = payload.sid;
  const exp = payload.exp;
  if (typeof sid !== "string" || sid.length === 0 || !Number.isInteger(exp)) {
    throw new Error("WorkOS AuthKit callback returned incomplete access token claims");
  }
  return { sessionId: sid, expiresAt: exp as number };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  const payload = parts[1];
  if (!payload) {
    throw new Error("WorkOS AuthKit callback returned an invalid access token");
  }

  const json = base64UrlDecode(payload);
  const parsed = JSON.parse(json) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("WorkOS AuthKit callback returned an invalid access token payload");
  }
  return parsed as Record<string, unknown>;
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  if (typeof atob === "function") {
    return atob(padded);
  }
  return Buffer.from(padded, "base64").toString("utf8");
}

function requestIp(request: Request): string | undefined {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) {
    return cfIp;
  }
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
}
