import { env as workerEnv } from "cloudflare:workers";
import { createRepository } from "@splitch/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { controlPanelBindings } from "./bindings";
import {
  assertClaimInitiator,
  ClaimCeremonyError,
  claimCompletionKind,
  postClaimCeremony,
} from "./claim-ceremony";
import { buildSessionPrincipal, rehydrateLegacySession } from "./membership";
import { refreshSession, type StoredSession, serverOnlySessionFields, sessionKey } from "./session";
import { loadSessionFromRequest } from "./session-refresh";

export type ClaimActionResult =
  | { kind: "otp_required" }
  | { kind: "claimed" }
  | { kind: "handoff_required" }
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
  completeTransfer?: boolean;
}

interface PendingClaim {
  version: 1;
  userId: string;
  orgId: string;
  email: string;
  identityAssertion: string;
  verificationId: string;
  idempotencyKey: string;
}

const CLAIM_INTENT_TTL_SECONDS = 10 * 60;

export const submitClaimCeremony = createServerFn({ method: "POST" })
  .validator((data: ClaimActionInput) => data)
  .handler(async ({ data }): Promise<ClaimActionResult> => {
    const bindings = controlPanelBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings, getRequest());
    if (!loaded.ok) return error("unauthenticated", "Sign in before claiming this Organization.");

    const repo = createRepository(bindings.DB);
    const session = await rehydrateLegacySession(
      repo,
      bindings.SESSION_STORE,
      loaded.tokenHash,
      loaded.session,
    );
    const context = claimContext({ ...loaded, session }, data.orgSlug);
    if ("kind" in context) {
      return context;
    }

    try {
      if (data.otp === undefined && !data.completeTransfer) {
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
  workosAccessToken?: string;
  workosRefreshToken?: string;
  workosAccessTokenExpiresAt?: number;
  expiresAt: number;
};

export function claimSessionAfterRefresh(
  context: ClaimContext,
  principal: Awaited<ReturnType<typeof buildSessionPrincipal>>,
): StoredSession {
  return {
    ...principal,
    expiresAt: context.expiresAt,
    ...serverOnlySessionFields(context),
  };
}

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
    ...serverOnlySessionFields(loaded.session),
    workosSessionId: loaded.session.workosSessionId,
    expiresAt: loaded.session.expiresAt,
  };
}

async function startClaimCeremony(
  bindings: ReturnType<typeof controlPanelBindings>,
  context: ClaimContext,
  data: ClaimActionInput,
): Promise<ClaimActionResult> {
  try {
    const response = await postClaimCeremony(bindings.AUTH_API_ORIGIN, {
      identityAssertion: data.identityAssertion,
      email: data.email,
    });
    if (!("otpRequired" in response)) {
      return error("invalid_grant", "This Organization has already been claimed.");
    }
    assertClaimInitiator(response, context);
    await storePendingClaim(bindings.SESSION_STORE, context, {
      email: data.email,
      identityAssertion: data.identityAssertion,
      verificationId: response.verificationId,
      idempotencyKey: crypto.randomUUID(),
    });
    return { kind: "otp_required" };
  } catch (cause) {
    if (cause instanceof ClaimCeremonyError && cause.code === "interaction_required") {
      if (!cause.verificationId) {
        return error("server_error", "Auth API omitted the durable claim verification identifier.");
      }
      await storePendingClaim(bindings.SESSION_STORE, context, {
        email: data.email,
        identityAssertion: data.identityAssertion,
        verificationId: cause.verificationId,
        idempotencyKey: crypto.randomUUID(),
      });
    }
    throw cause;
  }
}

async function verifyClaimCeremony(
  bindings: ReturnType<typeof controlPanelBindings>,
  context: ClaimContext,
  data: ClaimActionInput,
): Promise<ClaimActionResult> {
  const pendingKey = claimIntentKey(context.tokenHash, context.orgId);
  const pending = await loadPendingClaim(bindings.SESSION_STORE, pendingKey, context);
  if (!pending) {
    return error(
      "invalid_grant",
      "Start the claim ceremony again before entering the one-time password.",
    );
  }
  const response = await postClaimCeremony(bindings.AUTH_API_ORIGIN, {
    identityAssertion: pending.identityAssertion,
    email: pending.email,
    otp: data.otp,
    verificationId: pending.verificationId,
    idempotencyKey: pending.idempotencyKey,
  });
  if ("otpRequired" in response) {
    return error("server_error", "Auth API did not complete the claim ceremony.");
  }
  if (claimCompletionKind(response, context) === "transferred") {
    await bindings.SESSION_STORE.delete(sessionKey(context.tokenHash));
    await bindings.SESSION_STORE.delete(pendingKey);
    return { kind: "handoff_required" };
  }

  const repo = createRepository(bindings.DB);
  const refreshedPrincipal = await buildSessionPrincipal(repo, context);
  await refreshSession(
    bindings.SESSION_STORE,
    context.tokenHash,
    claimSessionAfterRefresh(context, refreshedPrincipal),
  );
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

async function loadPendingClaim(
  kv: KVNamespace,
  key: string,
  context: ClaimContext,
): Promise<PendingClaim | null> {
  const raw = await kv.get(key, "text");
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (isPendingClaim(value, context)) {
      return value;
    }
  } catch {
    // Fall through to a fail-loud restart requirement.
  }
  return null;
}

function isPendingClaim(value: unknown, context: ClaimContext): value is PendingClaim {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as PendingClaim).version === 1 &&
    (value as PendingClaim).userId === context.userId &&
    (value as PendingClaim).orgId === context.orgId &&
    typeof (value as PendingClaim).email === "string" &&
    (value as PendingClaim).email.length > 0 &&
    typeof (value as PendingClaim).identityAssertion === "string" &&
    (value as PendingClaim).identityAssertion.length > 0 &&
    typeof (value as PendingClaim).verificationId === "string" &&
    (value as PendingClaim).verificationId.length > 0 &&
    typeof (value as PendingClaim).idempotencyKey === "string" &&
    (value as PendingClaim).idempotencyKey.length > 0
  );
}

async function storePendingClaim(
  kv: KVNamespace,
  context: ClaimContext,
  pending: Omit<PendingClaim, "version" | "userId" | "orgId">,
): Promise<void> {
  await kv.put(
    claimIntentKey(context.tokenHash, context.orgId),
    JSON.stringify({ version: 1, userId: context.userId, orgId: context.orgId, ...pending }),
    { expirationTtl: CLAIM_INTENT_TTL_SECONDS },
  );
}
