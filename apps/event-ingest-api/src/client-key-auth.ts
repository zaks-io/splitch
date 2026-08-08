import {
  apiKeyCacheKey,
  CredentialCacheKVSchema,
  clientKeyCacheKey,
  type ErrorResponse,
  kvEnvelope,
} from "@splitch/contracts";
import type { Env, Outcome } from "./types";

export interface MetricEventCredentialScope {
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
export async function authenticateDelegatedDataPlaneCredential(
  identity: { actorId: string; appId: string | null; environmentId: string | null },
  env: Env,
): Promise<Outcome<MetricEventCredentialScope>> {
  if (!env.CREDENTIAL_STORE) {
    return failure("SERVICE_UNAVAILABLE", "Credential service is unavailable");
  }
  const delegated = delegatedCredential(identity.actorId);
  if (delegated === null) return failure("UNAUTHORIZED", "Client Key or API Key required");
  const raw = await env.CREDENTIAL_STORE.get(cacheKey(delegated), "text");
  if (raw === null) return failure("UNAUTHORIZED", `${credentialLabel(delegated.kind)} is unknown`);

  let parsed: ReturnType<typeof credentialEnvelope.safeParse>;
  try {
    parsed = credentialEnvelope.safeParse(JSON.parse(raw));
  } catch {
    return failure("INTERNAL_SERVER_ERROR", "Credential data is malformed");
  }
  if (!parsed.success) return failure("INTERNAL_SERVER_ERROR", "Credential data is invalid");
  const credential = parsed.data.data;
  const label = credentialLabel(delegated.kind);
  if (credential.kind !== delegated.kind) return failure("UNAUTHORIZED", `${label} is unknown`);
  if (credential.revoked) return failure("CREDENTIAL_REVOKED", `${label} is revoked`);
  if (!credential.scopes.includes("data-plane:write")) {
    return {
      ok: false,
      error: {
        code: "INSUFFICIENT_SCOPES",
        message: `${label} cannot write Metric Events`,
        details: { requiredScopes: ["data-plane:write"], heldScopes: credential.scopes },
      },
    };
  }
  if (credential.appId !== identity.appId || credential.environmentId !== identity.environmentId) {
    return failure(
      "INTERNAL_SERVER_ERROR",
      `${label} scope does not match the authorized App and Environment`,
    );
  }
  return {
    ok: true,
    value: {
      credentialHash: delegated.hash,
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

interface DelegatedCredential {
  readonly kind: "api_key" | "client_key";
  readonly hash: string;
}

function delegatedCredential(actorId: string): DelegatedCredential | null {
  const match = /^(api_key|client_key):([a-f0-9]{64})$/.exec(actorId);
  if (!match?.[1] || !match[2]) return null;
  return { kind: match[1] as DelegatedCredential["kind"], hash: match[2] };
}

function cacheKey(credential: DelegatedCredential): string {
  return credential.kind === "client_key"
    ? clientKeyCacheKey(credential.hash)
    : apiKeyCacheKey(credential.hash);
}

function credentialLabel(kind: DelegatedCredential["kind"]): "API Key" | "Client Key" {
  return kind === "client_key" ? "Client Key" : "API Key";
}
