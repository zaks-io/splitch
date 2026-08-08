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

// The checks stay ordered so a stale or inconsistent delegated identity cannot
// reach a later Metric Event guard with a plausible tenant scope.
//
// Origin is deliberately absent: on the delegated path the Evaluation Worker has
// already held the Client Key's origin allow-list against the browser's Origin
// header at the public edge, and the browser header does not survive the
// binding, so re-checking it here could only ever compare against nothing.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch is a distinct fail-loud credential contract
export async function authenticateDelegatedClientKey(
  identity: { actorId: string; appId: string | null; environmentId: string | null },
  env: Env,
): Promise<Outcome<ClientKeyScope>> {
  if (!env.CREDENTIAL_STORE) {
    return failure("SERVICE_UNAVAILABLE", "Client Key service is unavailable");
  }
  const credentialHash = delegatedClientKeyHash(identity.actorId);
  if (credentialHash === null) return failure("UNAUTHORIZED", "Client Key required");
  const raw = await env.CREDENTIAL_STORE.get(clientKeyCacheKey(credentialHash), "text");
  if (raw === null) return failure("UNAUTHORIZED", "Client Key is unknown");

  let parsed: ReturnType<typeof credentialEnvelope.safeParse>;
  try {
    parsed = credentialEnvelope.safeParse(JSON.parse(raw));
  } catch {
    return failure("INTERNAL_SERVER_ERROR", "Client Key data is malformed");
  }
  if (!parsed.success) return failure("INTERNAL_SERVER_ERROR", "Client Key data is invalid");
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
  if (credential.appId !== identity.appId || credential.environmentId !== identity.environmentId) {
    return failure(
      "INTERNAL_SERVER_ERROR",
      "Client Key scope does not match the authorized App and Environment",
    );
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

function delegatedClientKeyHash(actorId: string): string | null {
  const match = /^client_key:([a-f0-9]{64})$/.exec(actorId);
  return match?.[1] ?? null;
}
