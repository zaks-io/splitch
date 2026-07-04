import type { Repository } from "@splitch/db";
import { normalizeEmail } from "./email";
import { OAuthError } from "./oauth-errors";
import type { ClaimRecord, IdempotencyStore, OtpVerifier } from "./otp";
import type { RateLimiter } from "./rate-limit";
import type { TokenSigner } from "./token-exchange";
import type { WorkOsPort } from "./workos";

/**
 * Door B claim ceremony (auth-doors.md). A TWO-STEP flow because the OTP must
 * prove possession of the email being claimed, and a provisional user has no
 * email at register time:
 *
 *   INITIATE (POST /claim, no otp): normalize the claimed email, verify the
 *     provisional assertion, and SEND a code to THAT email. No mutation.
 *   VERIFY   (POST /claim, with otp + idempotency_key): re-authenticate the
 *     assertion FIRST, then atomically reserve the idempotency key. A replay only
 *     re-mints a token when the verified caller matches the stored record (so the
 *     key alone never mints a token); the winner verifies the code, rejects a
 *     collision (interaction_required, never merge), then verify-email +
 *     clear-provisional + upgrade scopes. A winner that fails RELEASES the
 *     reservation so a legitimate retry can re-run.
 *
 * The SAME canonical email feeds the OTP binding, the collision lookup, AND the
 * verify-email write, so a plus/IDN/case variant cannot pass one check and write
 * another. The WorkOS port keys its verified-email index on that same canonical
 * form, so the collision lookup and the stored index can never disagree. All D1
 * access is through the repo seam.
 */

const CONSENT_TTL_MS = 15 * 60 * 1000; // consent link valid 15 min (auth-doors.md)
const CLAIMED_ROLE = "owner"; // the claimer owns the workspace they just claimed

export interface ClaimDeps {
  repo: Repository;
  workos: WorkOsPort;
  otp: OtpVerifier;
  idempotency: IdempotencyStore;
  tokenSigner: TokenSigner;
  rateLimiter: RateLimiter;
  /** Base URL the human visits to approve linking on a collision (consent_url). */
  consentBaseUrl: string;
  now: () => number;
}

export interface InitiateInput {
  identityAssertion: string;
  email: string;
  remoteIp: string | undefined;
}

export interface VerifyInput {
  identityAssertion: string;
  otp: string;
  email: string;
  idempotencyKey: string;
  remoteIp: string | undefined;
}

export interface ClaimResult {
  access_token: string;
  user_id: string;
  org_id: string;
  app_id: string;
}

interface Provisional {
  userId: string;
  orgId: string;
  appId: string;
  email: string;
}

/** Pull the App id out of the pre-claim `app:{app_id}:member` scope grant. */
function appIdFromScopes(scopes: string[]): string {
  for (const scope of scopes) {
    const parts = scope.split(":");
    if (parts.length === 3 && parts[0] === "app" && parts[1]) {
      return parts[1];
    }
  }
  throw new OAuthError("invalid_grant", "identity_assertion carries no pre-claim App scope");
}

/** Full post-claim grant: owner on the claimed App (auth-doors.md step 5). */
function claimedScopes(appId: string): string[] {
  return [`app:${appId}:${CLAIMED_ROLE}`];
}

/**
 * Verify the caller's assertion and resolve WHO they are claiming for: the
 * (userId, orgId, appId) the assertion authorizes plus the canonical email. This
 * runs on EVERY claim call — including an idempotency replay — so a replay is
 * authenticated by the caller's own valid assertion, never by knowing the key
 * (Finding 1). The provisional gate is deliberately NOT here: a successful claim
 * clears provisional, so a same-caller replay must still resolve its identity.
 */
async function resolveIdentity(
  deps: ClaimDeps,
  identityAssertion: string,
  rawEmail: string,
  nowSeconds: number,
): Promise<Provisional> {
  const identity = await deps.tokenSigner.verifyIdentityAssertion(identityAssertion, nowSeconds);
  const appId = appIdFromScopes(identity.scopes);
  const email = normalizeEmail(rawEmail);
  const app = await deps.repo.identity.getApp(appId);
  if (!app) {
    throw new OAuthError("invalid_grant", "pre-claim App no longer exists");
  }
  return { userId: identity.userId, orgId: app.organizationId, appId, email };
}

/**
 * The provisional gate for a FRESH (mutating) claim: only the first claim mutates,
 * so only it requires the Org to still be awaiting a claim. (A successful claim
 * clears provisional, so this must NOT run on the replay path.)
 */
async function assertStillProvisional(deps: ClaimDeps, orgId: string): Promise<void> {
  const org = await deps.repo.identity.getOrg(orgId);
  if (!org?.isProvisional) {
    throw new OAuthError("invalid_grant", "workspace is not awaiting a claim");
  }
}

/** INITIATE: send an OTP to the claimed email. No account mutation. */
export async function initiateClaim(
  deps: ClaimDeps,
  input: InitiateInput,
): Promise<{ otp_required: true; user_id: string; org_id: string }> {
  const nowMs = deps.now();
  // Rate-gate the same surface as register: issuing codes is an abuse vector too.
  deps.rateLimiter.assertUnderCeiling(input.remoteIp ?? "unknown", nowMs);
  const p = await resolveIdentity(
    deps,
    input.identityAssertion,
    input.email,
    Math.floor(nowMs / 1000),
  );
  await assertStillProvisional(deps, p.orgId);
  deps.otp.issue(p.userId, p.email, nowMs);
  return { otp_required: true, user_id: p.userId, org_id: p.orgId };
}

/** VERIFY: confirm the code, refuse a collision, upgrade the identity. */
export async function verifyClaim(deps: ClaimDeps, input: VerifyInput): Promise<ClaimResult> {
  const nowMs = deps.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  deps.rateLimiter.assertUnderCeiling(input.remoteIp ?? "unknown", nowMs);

  // Re-authenticate BEFORE touching the reservation. The caller's assertion is
  // verified on EVERY call, so a replay is authorized by the caller's own valid
  // assertion — never by merely knowing the (attacker-suppliable) idempotency_key
  // (Finding 1). Idempotency means "the same authenticated caller retrying is
  // safe", not "anyone with the key gets a token".
  const caller = await resolveIdentity(deps, input.identityAssertion, input.email, nowSeconds);

  // Atomically reserve the idempotency key BEFORE any mutation. A concurrent or
  // replayed claim with the same key loses; it then replays the stored result
  // ONLY if the verified caller matches the stored record, or (if the winner is
  // still in-flight) fails loud rather than double-claiming.
  const reservation = deps.idempotency.reserve(input.idempotencyKey);
  if (!reservation.won) {
    if (reservation.record) {
      assertCallerOwnsRecord(caller, reservation.record);
      return tokenize(deps, reservation.record, nowSeconds);
    }
    throw new OAuthError("invalid_request", "a claim with this idempotency_key is in progress");
  }

  // Winner: run the mutating ceremony. If ANY step throws, release the reservation
  // so a legitimate retry can re-run (Finding 3) — only a SUCCESSFUL claim leaves
  // the key permanently completed. A concurrent in-flight loser still fails loud
  // above while we hold the reservation; we release only once we have definitively
  // failed, so this never reopens the TOCTOU.
  try {
    const record = await runClaimCeremony(deps, caller, input.otp, nowMs);
    deps.idempotency.complete(input.idempotencyKey, record);
    return tokenize(deps, record, nowSeconds);
  } catch (err) {
    deps.idempotency.release(input.idempotencyKey);
    throw err;
  }
}

/**
 * A replay only re-mints the original claimant's token: the verified caller must
 * resolve to the SAME (userId, orgId, appId) bound in the stored record. A
 * different (even validly-authenticated) user presenting the key is rejected with
 * NO token minted (Finding 1).
 */
function assertCallerOwnsRecord(caller: Provisional, record: ClaimRecord): void {
  if (
    caller.userId !== record.userId ||
    caller.orgId !== record.orgId ||
    caller.appId !== record.appId
  ) {
    throw new OAuthError("invalid_grant", "identity_assertion does not match this claim");
  }
}

/**
 * The mutating half of a fresh claim: assert still-provisional, verify the OTP,
 * refuse a collision, then verify-email + clear-provisional. Returns the record to
 * store. Throws (fail-loud) on any failure so the caller releases the reservation.
 */
async function runClaimCeremony(
  deps: ClaimDeps,
  p: Provisional,
  otp: string,
  nowMs: number,
): Promise<ClaimRecord> {
  await assertStillProvisional(deps, p.orgId);

  // OTP bound to (userId, canonical email): proves possession of THIS address,
  // and is attempt-capped (lockout) against brute force.
  deps.otp.assertValid(p.userId, p.email, otp, nowMs);

  // Collision: an existing VERIFIED user for this email is account takeover.
  const existing = await deps.workos.findVerifiedUserByEmail(p.email);
  if (existing && existing !== p.userId) {
    throw new OAuthError(
      "interaction_required",
      "this email already belongs to a verified account; the owner must approve linking",
      {
        // Do NOT reflect the email — the consent page looks it up from the org.
        consent_url: `${deps.consentBaseUrl}/claim/consent?org=${p.orgId}`,
        consent_expires_at: new Date(nowMs + CONSENT_TTL_MS).toISOString(),
      },
    );
  }

  await deps.workos.verifyEmail(p.userId, p.email);
  const cleared = await deps.repo.identity.clearProvisional(p.orgId, new Date(nowMs).toISOString());
  if (cleared === 0) {
    throw new OAuthError("server_error", "provisional state changed during claim");
  }

  return { userId: p.userId, orgId: p.orgId, appId: p.appId };
}

/** Mint the upgraded access token for a (possibly replayed) claim result. */
async function tokenize(
  deps: ClaimDeps,
  record: ClaimRecord,
  nowSeconds: number,
): Promise<ClaimResult> {
  const access_token = await deps.tokenSigner.mintAccessToken(
    record.userId,
    claimedScopes(record.appId),
    "anonymous",
    nowSeconds,
  );
  return {
    access_token,
    user_id: record.userId,
    org_id: record.orgId,
    app_id: record.appId,
  };
}
