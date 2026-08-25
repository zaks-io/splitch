import { type AuthDoor, AuthDoorSchema } from "@splitch/contracts";
import { type AuthResolver, remoteJwksSignatureVerifier } from "@splitch/worker-runtime";

interface VerifiedToken {
  sub: string;
  scopes: string[];
  /** `auth_door`. An unrecognized/missing claim reads as the least-privileged door. */
  authDoor: AuthDoor;
}

interface JwksVerifier {
  verify(token: string, nowSeconds: number): Promise<VerifiedToken | null>;
}

export function makeCachedJwksVerifier(options: {
  jwksUri: string;
  controlPlaneAudience: string;
}): JwksVerifier {
  const signatures = remoteJwksSignatureVerifier(options.jwksUri);
  return {
    async verify(token, nowSeconds) {
      const parsed = parseJwt(token);
      if (!parsed || !(await signatures.verify(token))) return null;
      return actorFromClaims(parsed.payload, options.controlPlaneAudience, nowSeconds);
    },
  };
}

interface SessionStore {
  isRevoked(sessionId: string): Promise<boolean>;
}

const BEARER_PREFIX = "Bearer ";
const REVOKED_PREFIX = "revoked:";
const APP_SCOPE = /^app:([^:]+):(owner|admin|member)$/;
const ORG_SCOPE = /^org:([^:]+):(owner|admin|member)$/;

export function makeControlPlaneAuthResolver(deps: {
  verifier: JwksVerifier;
  sessions: SessionStore;
  now?: () => number;
}): AuthResolver {
  const nowSeconds = () => Math.floor((deps.now?.() ?? Date.now()) / 1000);

  return async (request) => {
    const token = bearerToken(request.headers.get("authorization"));
    if (token === null) {
      return { ok: false, reason: "UNAUTHORIZED" };
    }

    const verified = await deps.verifier.verify(token, nowSeconds());
    if (verified === null) {
      return { ok: false, reason: "UNAUTHORIZED" };
    }
    if (await deps.sessions.isRevoked(verified.sub)) {
      return { ok: false, reason: "CREDENTIAL_REVOKED" };
    }

    return {
      ok: true,
      principal: {
        kind: "control-plane-token",
        id: verified.sub,
        scopes: verified.scopes,
        orgId: soleId(idsInScopes(verified.scopes, ORG_SCOPE)),
        appId: soleId(idsInScopes(verified.scopes, APP_SCOPE)),
        environmentId: null,
        authDoor: verified.authDoor,
      },
    };
  };
}

export function makeSessionStore(kv: KVNamespace): SessionStore {
  return {
    async isRevoked(sessionId) {
      return (await kv.get(`${REVOKED_PREFIX}${sessionId}`)) !== null;
    },
  };
}

function bearerToken(header: string | null): string | null {
  if (!header?.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? null : token;
}

function idsInScopes(scopes: readonly string[], pattern: RegExp): Set<string> {
  const ids = new Set<string>();
  for (const scope of scopes) {
    const match = pattern.exec(scope);
    if (match?.[1]) {
      ids.add(match[1]);
    }
  }
  return ids;
}

function soleId(ids: Set<string>): string | null {
  return ids.size === 1 ? ([...ids][0] as string) : null;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
}

interface ParsedJwt {
  payload: Record<string, unknown>;
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const payloadSeg = parts[1] as string;
  try {
    return {
      payload: decodeSegment(payloadSeg),
    };
  } catch {
    return null;
  }
}

function actorFromClaims(
  payload: Record<string, unknown>,
  controlPlaneAudience: string,
  nowSeconds: number,
): VerifiedToken | null {
  if (payload.aud !== controlPlaneAudience) {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds) {
    return null;
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return null;
  }
  return {
    sub: payload.sub,
    scopes: Array.isArray(payload.scopes) ? payload.scopes.filter(isString) : [],
    authDoor: AuthDoorSchema.safeParse(payload.auth_door).data ?? "anonymous",
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
