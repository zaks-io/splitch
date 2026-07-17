import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env as workerEnv } from "cloudflare:workers";
import { controlPanelBindings } from "./bindings";
import { assertClaimActor, ClaimCeremonyError, postClaimCeremony } from "./claim-ceremony";
import { buildSessionPrincipal } from "./membership";
import { loadSessionFromRequest, refreshSession } from "./session";

export type ClaimActionResult =
  | { kind: "otp_required" }
  | { kind: "claimed" }
  | {
      kind: "error";
      code: string;
      message: string;
      consentUrl?: string;
      consentExpiresAt?: string;
    };

interface ClaimActionInput {
  orgSlug: string;
  identityAssertion: string;
  email: string;
  otp?: string;
  idempotencyKey?: string;
}

interface PendingClaim {
  email: string;
  identityAssertion: string;
}

const CLAIM_INTENT_TTL_SECONDS = 10 * 60;

export const submitClaimCeremony = createServerFn({ method: "POST" })
  .validator((data: ClaimActionInput) => data)
  .handler(async ({ data }): Promise<ClaimActionResult> => {
    const bindings = controlPanelBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
    const context = claimContext(loaded, data.orgSlug);
    if ("kind" in context) {
      return context;
    }

    try {
      if (data.otp === undefined) {
        return await startClaimCeremony(bindings, context, data);
      }
      return await verifyClaimCeremony(bindings, context, data);
    } catch (cause) {
      if (cause instanceof ClaimCeremonyError) {
        return error(cause.code, cause.message, cause.consentUrl, cause.consentExpiresAt);
      }
      throw cause;
    }
  });

type ClaimContext = {
  tokenHash: string;
  userId: string;
  orgId: string;
  workosSessionId: string;
  expiresAt: number;
};

function claimContext(
  loaded: Awaited<ReturnType<typeof loadSessionFromRequest>>,
  orgSlug: string,
): ClaimContext | ClaimActionResult {
  if (!loaded.ok) {
    return error("unauthenticated", "Sign in before claiming this Organization.");
  }
  const organization = loaded.session.orgs.find((org) => org.orgSlug === orgSlug);
  if (!organization) {
    return error("access_denied", "You are not a member of this Organization.");
  }
  if (!organization.isProvisional) {
    return error("invalid_grant", "This Organization has already been claimed.");
  }
  if (!loaded.session.workosSessionId) {
    return error(
      "invalid_session",
      "Your panel session is incomplete. Sign in again before claiming.",
    );
  }
  return {
    tokenHash: loaded.tokenHash,
    userId: loaded.session.userId,
    orgId: organization.orgId,
    workosSessionId: loaded.session.workosSessionId,
    expiresAt: loaded.session.expiresAt,
  };
}

async function startClaimCeremony(
  bindings: ReturnType<typeof controlPanelBindings>,
  context: ClaimContext,
  data: ClaimActionInput,
): Promise<ClaimActionResult> {
  const response = assertClaimActor(
    await postClaimCeremony(bindings.AUTH_API_ORIGIN, {
      identityAssertion: data.identityAssertion,
      email: data.email,
    }),
    context,
  );
  if (!("otpRequired" in response)) {
    return error("invalid_grant", "This Organization has already been claimed.");
  }
  await bindings.SESSION_STORE.put(
    claimIntentKey(context.tokenHash, context.orgId),
    JSON.stringify({ email: data.email, identityAssertion: data.identityAssertion }),
    { expirationTtl: CLAIM_INTENT_TTL_SECONDS },
  );
  return { kind: "otp_required" };
}

async function verifyClaimCeremony(
  bindings: ReturnType<typeof controlPanelBindings>,
  context: ClaimContext,
  data: ClaimActionInput,
): Promise<ClaimActionResult> {
  if (!data.idempotencyKey) {
    return error("invalid_request", "A claim idempotency key is required to verify the password.");
  }
  const pendingKey = claimIntentKey(context.tokenHash, context.orgId);
  const pending = await loadPendingClaim(bindings.SESSION_STORE, pendingKey);
  if (!pending) {
    return error(
      "invalid_grant",
      "Start the claim ceremony again before entering the one-time password.",
    );
  }
  const response = assertClaimActor(
    await postClaimCeremony(bindings.AUTH_API_ORIGIN, {
      identityAssertion: pending.identityAssertion,
      email: pending.email,
      otp: data.otp,
      idempotencyKey: data.idempotencyKey,
    }),
    context,
  );
  if ("otpRequired" in response) {
    return error("server_error", "Auth API did not complete the claim ceremony.");
  }
  const repo = createRepository(bindings.DB);
  const refreshedPrincipal = await buildSessionPrincipal(repo, context);
  await refreshSession(bindings.SESSION_STORE, context.tokenHash, {
    ...refreshedPrincipal,
    expiresAt: context.expiresAt,
  });
  await bindings.SESSION_STORE.delete(pendingKey);
  return { kind: "claimed" };
}

function error(
  code: string,
  message: string,
  consentUrl?: string,
  consentExpiresAt?: string,
): ClaimActionResult {
  return { kind: "error", code, message, consentUrl, consentExpiresAt };
}

function claimIntentKey(tokenHash: string, orgId: string): string {
  return `claim-intent:${tokenHash}:${orgId}`;
}

async function loadPendingClaim(kv: KVNamespace, key: string): Promise<PendingClaim | null> {
  const raw = await kv.get(key, "text");
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (isPendingClaim(value)) {
      return value;
    }
  } catch {
    // Fall through to a fail-loud restart requirement.
  }
  return null;
}

function isPendingClaim(value: unknown): value is PendingClaim {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as PendingClaim).email === "string" &&
    (value as PendingClaim).email.length > 0 &&
    typeof (value as PendingClaim).identityAssertion === "string" &&
    (value as PendingClaim).identityAssertion.length > 0
  );
}
