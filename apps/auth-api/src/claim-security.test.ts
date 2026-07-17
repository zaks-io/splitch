import { describe, expect, it } from "vitest";
import { approveClaimConsent, initiateClaim, refuseClaimConsent, verifyClaim } from "./claim";
import { EMAIL, setupClaimHarness } from "./claim-harness";
import { FIXTURE_OTP } from "./otp";

/**
 * Door B claim — SECURITY-FINDING regressions (BugBot on the SPL-24 fix).
 *
 *   FINDING 1 (auth bypass): an idempotency replay must be RE-AUTHENTICATED. The
 *     stored record is bound to its claimant's identity, so only the same
 *     authenticated caller can replay it; the key alone never mints a token.
 *   FINDING 2 (IDN takeover): the WorkOS verified-email index and the collision
 *     lookup share ONE normalizeEmail() canonical form, so a Unicode/punycode
 *     variant of one mailbox can't slip past the takeover check.
 *   FINDING 3 (key lockout): a winner whose ceremony FAILS releases the
 *     reservation, so a legitimate retry re-runs instead of seeing "in progress".
 */

const { deps, register, fullClaim, isProvisional, count, setProvisional } = setupClaimHarness();

type ClaimConsentError = {
  code: string;
  extra: { consent_url?: string; verification_id?: string };
};

describe("FINDING 1: idempotency replay is RE-AUTHENTICATED (no key-only token mint)", () => {
  it("a replay with a DIFFERENT user's valid assertion is rejected (no token minted)", async () => {
    const d = deps();
    // Victim completes a real claim under idem-key K.
    const { assertion: victim, orgId } = await register(d);
    const first = (await fullClaim(d, victim, EMAIL, "shared-key")) as {
      org_id: string;
      app_id: string;
      user_id: string;
    };
    expect(await isProvisional(orgId)).toBe(false);

    // Attacker holds a DIFFERENT, fully-valid provisional assertion (own workspace)
    // and replays the SAME key. Re-auth resolves the attacker, who does NOT own the
    // stored record → rejected, no token. (Before the fix the key alone minted one.)
    const { assertion: attacker } = await register(d);
    await expect(
      verifyClaim(d.claim, {
        identityAssertion: attacker,
        otp: FIXTURE_OTP,
        email: EMAIL,
        idempotencyKey: "shared-key",
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    // The original caller's replay still returns the stored result (idempotent).
    const replay = await verifyClaim(d.claim, {
      identityAssertion: victim,
      otp: FIXTURE_OTP,
      email: EMAIL,
      idempotencyKey: "shared-key",
      remoteIp: "1.2.3.4",
    });
    expect(replay.org_id).toBe(first.org_id);
    expect(replay.app_id).toBe(first.app_id);
    expect(replay.user_id).toBe(first.user_id);
  });

  it("a replay with NO/invalid assertion is rejected before any token is minted", async () => {
    const d = deps();
    const { assertion } = await register(d);
    await fullClaim(d, assertion, EMAIL, "key-2");
    await expect(
      verifyClaim(d.claim, {
        identityAssertion: "not-a-real-assertion",
        otp: FIXTURE_OTP,
        email: EMAIL,
        idempotencyKey: "key-2",
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("FINDING 2: WorkOS index + collision check share ONE canonicalization", () => {
  it("a Unicode/punycode variant of an email owned via Door A is caught by the collision check", async () => {
    const d = deps();
    // Door A path verifies a user for an IDN domain in its UNICODE form. normalizeEmail
    // folds the domain to punycode (xn--), so a naive toLowerCase index would NOT
    // match the punycode lookup the claim does — that mismatch was the takeover hole.
    const unicodeForm = "owner@bücher.example"; // ü domain
    const punycodeForm = "owner@xn--bcher-kva.example"; // same mailbox, ASCII form
    await d.workos.resolveOrCreateUser(unicodeForm);

    const { assertion, orgId } = await register(d);
    // Door B claims the PUNYCODE form of the SAME mailbox: must collide, not merge.
    await expect(fullClaim(d, assertion, punycodeForm)).rejects.toMatchObject({
      code: "interaction_required",
    });
    expect(await isProvisional(orgId)).toBe(true);
  });
});

describe("SPL-137 transfer guards and consent one-use semantics", () => {
  it("does not consume state or mint idempotency when the Organization acquisition guard fails", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    await setProvisional(orgId, false);

    await expect(
      verifyClaim(d.claim, {
        identityAssertion: assertion,
        otp: FIXTURE_OTP,
        email: EMAIL,
        idempotencyKey: "guard-failure",
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await count("claim_idempotency")).toBe(0);
    expect(await count("claim_consent_attempts")).toBe(0);
  });

  it("rejects a competing idempotency key after the one-use transfer completed", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await fullClaim(d, assertion, EMAIL, "winner");

    await expect(
      verifyClaim(d.claim, {
        identityAssertion: assertion,
        otp: FIXTURE_OTP,
        email: EMAIL,
        idempotencyKey: "competitor",
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await count("claim_idempotency")).toBe(1);
    expect(await isProvisional(orgId)).toBe(false);
  });

  it("requires the existing AuthKit principal, refuses a second principal, and consumes consent once", async () => {
    const d = deps();
    const owner = await d.workos.resolveOrCreateUser("owner@example.com");
    const { assertion, orgId } = await register(d);
    let error: ClaimConsentError | undefined;
    try {
      await initiateClaim(d.claim, {
        identityAssertion: assertion,
        email: "owner@example.com",
        remoteIp: "1.2.3.4",
      });
    } catch (cause) {
      error = cause as ClaimConsentError;
    }
    const consentError = error as ClaimConsentError;
    const attemptId = new URL(consentError.extra.consent_url as string).pathname
      .split("/")
      .at(-1) as string;
    const verificationId = consentError.extra.verification_id as string;

    await expect(approveClaimConsent(d.claim, attemptId, "user_wrong")).rejects.toMatchObject({
      code: "invalid_grant",
    });
    await approveClaimConsent(d.claim, attemptId, owner);
    await expect(approveClaimConsent(d.claim, attemptId, owner)).rejects.toMatchObject({
      code: "invalid_grant",
    });

    const result = await verifyClaim(d.claim, {
      identityAssertion: assertion,
      verificationId,
      email: "owner@example.com",
      idempotencyKey: "consent-once",
      remoteIp: "1.2.3.4",
    });
    expect(result.user_id).toBe(owner);
    expect(await isProvisional(orgId)).toBe(false);
  });

  it("refusal and expiry cannot be reused", async () => {
    const d = deps();
    const owner = await d.workos.resolveOrCreateUser("owner@example.com");
    const { assertion } = await register(d);
    let error: ClaimConsentError | undefined;
    try {
      await initiateClaim(d.claim, {
        identityAssertion: assertion,
        email: "owner@example.com",
        remoteIp: "1.2.3.4",
      });
    } catch (cause) {
      error = cause as ClaimConsentError;
    }
    const consentError = error as ClaimConsentError;
    const attemptId = new URL(consentError.extra.consent_url as string).pathname
      .split("/")
      .at(-1) as string;
    await refuseClaimConsent(d.claim, attemptId, owner);
    await expect(approveClaimConsent(d.claim, attemptId, owner)).rejects.toMatchObject({
      code: "invalid_grant",
    });

    const expired = deps();
    const expiredOwner = await expired.workos.resolveOrCreateUser("expired@example.com");
    const { assertion: expiredAssertion } = await register(expired);
    let expiredError: ClaimConsentError | undefined;
    try {
      await initiateClaim(expired.claim, {
        identityAssertion: expiredAssertion,
        email: "expired@example.com",
        remoteIp: "1.2.3.4",
      });
    } catch (cause) {
      expiredError = cause as ClaimConsentError;
    }
    const expiredConsentError = expiredError as ClaimConsentError;
    const expiredAttempt = new URL(expiredConsentError.extra.consent_url as string).pathname
      .split("/")
      .at(-1) as string;
    await expect(
      approveClaimConsent(
        { ...expired.claim, now: () => 1_780_000_000_000 + 16 * 60 * 1000 },
        expiredAttempt,
        expiredOwner,
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});
