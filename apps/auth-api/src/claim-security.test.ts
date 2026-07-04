import { describe, expect, it } from "vitest";
import { EMAIL, setupClaimHarness } from "./claim-harness";
import { initiateClaim, verifyClaim } from "./claim";
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

const { deps, register, fullClaim, isProvisional } = setupClaimHarness();

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

describe("FINDING 3: a winner that FAILS releases the key (retry is not locked out)", () => {
  it("wrong OTP releases the reservation; a correct retry with the same key succeeds", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });

    // First attempt WINS the reservation but supplies the wrong OTP → ceremony throws.
    await expect(
      verifyClaim(d.claim, {
        identityAssertion: assertion,
        otp: "999999",
        email: EMAIL,
        idempotencyKey: "retry-key",
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    // The retry with the SAME key RE-RUNS the ceremony (not "in progress") and,
    // with the right code, succeeds. (Before the fix the key stayed locked forever.)
    const ok = await verifyClaim(d.claim, {
      identityAssertion: assertion,
      otp: FIXTURE_OTP,
      email: EMAIL,
      idempotencyKey: "retry-key",
      remoteIp: "1.2.3.4",
    });
    expect(ok.org_id).toBe(orgId);
    expect(await isProvisional(orgId)).toBe(false);
  });

  it("a concurrent in-flight loser still fails loud while the winner is mid-ceremony", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    const one = () =>
      verifyClaim(d.claim, {
        identityAssertion: assertion,
        otp: FIXTURE_OTP,
        email: EMAIL,
        idempotencyKey: "race-2",
        remoteIp: "1.2.3.4",
      });
    const settled = await Promise.allSettled([one(), one()]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejections = settled
      .filter((s): s is PromiseRejectedResult => s.status === "rejected")
      .map((s) => s.reason);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // An in-flight loser fails loud as invalid_request, never a double-mutated 500.
    for (const reason of rejections) {
      expect(reason.code).toBe("invalid_request");
    }
    expect(await isProvisional(orgId)).toBe(false);
  });
});
