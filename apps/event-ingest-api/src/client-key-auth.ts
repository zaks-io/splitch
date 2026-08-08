import {
  CredentialCacheKVSchema,
  clientKeyCacheKey,
  type ErrorResponse,
  kvEnvelope,
} from "@splitch/contracts";
import type { Env, Outcome } from "./types";

export interface ClientKeyScope {
  readonly credentialHash: string;
  readonly appId: string;
  readonly environmentId: string;
  readonly rateLimitRps: number | null;
}

const credentialEnvelope = kvEnvelope(CredentialCacheKVSchema);

// Credential rejection ordering stays linear here so no invalid state reaches a later guard.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch is a distinct fail-loud credential contract
export async function authenticateClientKey(
  request: Request,
  env: Env,
): Promise<Outcome<ClientKeyScope>> {
  if (!env.CREDENTIAL_STORE) return failure("SERVICE_UNAVAILABLE", "credential store unavailable");
  const material = bearerCredential(request);
  if (!material) return failure("UNAUTHORIZED", "Client Key required");
  const credentialHash = await sha256Hex(material);
  const raw = await env.CREDENTIAL_STORE.get(clientKeyCacheKey(credentialHash), "text");
  if (raw === null) return failure("UNAUTHORIZED", "Client Key is unknown");

  let parsed: ReturnType<typeof credentialEnvelope.safeParse>;
  try {
    parsed = credentialEnvelope.safeParse(JSON.parse(raw));
  } catch {
    return failure("INTERNAL_SERVER_ERROR", "credential cache is malformed");
  }
  if (!parsed.success) return failure("INTERNAL_SERVER_ERROR", "credential cache is invalid");
  const credential = parsed.data.data;
  if (credential.kind !== "client_key") return failure("UNAUTHORIZED", "Client Key required");
  if (credential.revoked) return failure("CREDENTIAL_REVOKED", "Client Key is revoked");
  if (!credential.scopes.includes("data-plane:write")) {
    return {
      ok: false,
      error: {
        code: "INSUFFICIENT_SCOPES",
        message: "Client Key cannot write Metric Events",
        details: { requiredScopes: ["data-plane:write"], heldScopes: credential.scopes },
      },
    };
  }
  const origin = requestOrigin(request);
  if (credential.originAllowlist !== null && credential.originAllowlist !== undefined) {
    const allowed = new Set(credential.originAllowlist.map(normalizeOrigin));
    if (origin === null || !allowed.has(origin)) {
      return {
        ok: false,
        error: {
          code: "ORIGIN_NOT_ALLOWED",
          message: "origin is not allowed for this Client Key",
          details: {
            origin: origin ?? "unknown",
            hint: "add this origin to the Client Key allow-list or open the key",
          },
        },
      };
    }
  }
  return {
    ok: true,
    value: {
      credentialHash,
      appId: credential.appId,
      environmentId: credential.environmentId,
      rateLimitRps: credential.rateLimitRps ?? null,
    },
  };
}

function failure(
  code: "UNAUTHORIZED" | "CREDENTIAL_REVOKED" | "SERVICE_UNAVAILABLE" | "INTERNAL_SERVER_ERROR",
  message: string,
): Outcome<never> {
  const details = code === "SERVICE_UNAVAILABLE" ? { retryAfterMs: 1000 } : {};
  return { ok: false, error: { code, message, details } as ErrorResponse };
}

function bearerCredential(request: Request): string | null {
  const [scheme, material] = request.headers.get("authorization")?.split(/\s+/, 2) ?? [];
  return scheme?.toLowerCase() === "bearer" && material ? material : null;
}

function requestOrigin(request: Request): string | null {
  const value = request.headers.get("origin") ?? request.headers.get("referer");
  return value === null ? null : normalizeOrigin(value);
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
