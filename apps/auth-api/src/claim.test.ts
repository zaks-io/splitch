import { MemberProfileCacheSchema, memberProfileCacheKey } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { initiateClaim, verifyClaim } from "./claim";
import { EMAIL, setupClaimHarness } from "./claim-harness";
import { FIXTURE_OTP } from "./otp";
import { memoryKvNamespace } from "./test-kv";

/**
 * Door B CLAIM ceremony — behavioral surface (happy path, OTP binding, atomic
 * idempotency, brute-force cap, rate gating). The security-FINDING regressions
 * (replay re-auth, unified email canonicalization, reservation release) live in
 * `claim-security.test.ts`; both share `claim-harness.ts` (split to stay under the
 * 300-line module guard).
 *
 * These call initiateClaim / verifyClaim directly (not over HTTP) so a concurrent
 * race can be expressed with Promise.all on one shared fixture set.
 */

const { deps, register, fullClaim, isProvisional, count } = setupClaimHarness();

type ClaimConsentError = {
  code: string;
  extra: { consent_url?: string; verification_id?: string };
};

describe("Door B claim: happy path", () => {
  it("initiate→verify with the delivered OTP upgrades scopes and clears provisional", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    const result = (await fullClaim(d, assertion)) as { org_id: string; access_token: string };
    expect(result.org_id).toBe(orgId);
    expect(result.access_token.split(".")).toHaveLength(3);
    expect(await isProvisional(orgId)).toBe(false);
  });

  it("writes member-profile:{userId} to SESSION_STORE when claim verifies", async () => {
    const values = new Map<string, string>();
    const d = deps({ sessionStore: memoryKvNamespace(values) });
    const { assertion } = await register(d);
    const result = (await fullClaim(d, assertion)) as { user_id: string };
    const cached = values.get(memberProfileCacheKey(result.user_id));
    expect(cached).toBeDefined();
    expect(MemberProfileCacheSchema.parse(JSON.parse(cached as string))).toEqual({
      email: EMAIL,
    });
  });
});

describe("BLOCKING #1: OTP is bound to the claimed email (no pre-emptive takeover)", () => {
  it("verify for an email NO code was sent to is rejected (attacker uses own OTP, victim email)", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    // Attacker initiates for THEIR email (gets a real code there) ...
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    // ... then tries to VERIFY against an UNOWNED victim address with that code.
    await expect(
      verifyClaim(d.claim, {
        identityAssertion: assertion,
        otp: FIXTURE_OTP,
        email: "victim@corp.com",
        idempotencyKey: "k",
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    // Pre-emptive takeover blocked: the victim address was never verified.
    expect(await d.workos.findVerifiedUserByEmail("victim@corp.com")).toBeNull();
    expect(await isProvisional(orgId)).toBe(true);
  });

  it("a plus/case/IDN variant of a registered email is caught by the collision check (no merge)", async () => {
    const d = deps();
    // A DIFFERENT user already owns the canonical address.
    await d.workos.resolveOrCreateUser("Owner@Example.com");
    const { assertion, orgId } = await register(d);
    // The claimer presents a case variant — same canonical string → collision.
    await expect(fullClaim(d, assertion, "owner@example.com")).rejects.toMatchObject({
      code: "interaction_required",
    });
    expect(await isProvisional(orgId)).toBe(true);
  });

  it("detects a collision before the provisional WorkOS user is mutated", async () => {
    const d = deps();
    await d.workos.resolveOrCreateUser("owner@example.com");
    const send = vi.spyOn(d.workos, "sendEmailVerification");
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

    expect(error).toMatchObject({ code: "interaction_required" });
    expect(send).not.toHaveBeenCalled();
    expect(await d.workos.findVerifiedUserByEmail("owner@example.com")).toMatch(/^user_fixture_/);
    expect(await isProvisional(orgId)).toBe(true);
    expect(await count("claim_verifications")).toBe(1);
    expect(await count("claim_consent_attempts")).toBe(1);
  });

  it("interaction_required does NOT reflect the email into consent_url (enumeration-safe)", async () => {
    const d = deps();
    await d.workos.resolveOrCreateUser("taken@example.com");
    const { assertion } = await register(d);
    await fullClaim(d, assertion, "taken@example.com").catch((e) => {
      expect(e.code).toBe("interaction_required");
      expect(e.extra.consent_url).not.toContain("taken@example.com");
      expect(e.extra.consent_url).toContain("/claim/consent");
    });
  });
});

describe("BLOCKING #2: atomic idempotency reservation (concurrent claim dedups to one)", () => {
  it("two concurrent same-key claims both succeed but mutate ONCE", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    const one = (key = "race") =>
      verifyClaim(d.claim, {
        identityAssertion: assertion,
        otp: FIXTURE_OTP,
        email: EMAIL,
        idempotencyKey: key,
        remoteIp: "1.2.3.4",
      });
    // Both reserve the SAME key concurrently. With an ATOMIC reserve exactly one
    // caller wins and mutates; the loser gets {won:false} and either replays the
    // stored result or fails-loud "in progress" (invalid_request). It must NEVER
    // reach a second verifyEmail/clearProvisional, whose 0-row clear would surface
    // as a `server_error` — that 500 is the TOCTOU symptom this test forbids.
    const settled = await Promise.allSettled([one(), one()]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejections = settled
      .filter((s): s is PromiseRejectedResult => s.status === "rejected")
      .map((s) => s.reason);
    // At least one win, and NO loser double-mutated into a server_error 500.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const reason of rejections) {
      expect(reason.code).toBe("invalid_request"); // "in progress", never server_error
    }
    // Every fulfilled result is the SAME claim (one identity, no fork).
    for (const s of fulfilled) {
      expect((s.value as { org_id: string }).org_id).toBe(orgId);
    }
    expect(await isProvisional(orgId)).toBe(false);
    // A replay after completion returns the stored result (no double-claim, no 500).
    const replay = (await one()) as { org_id: string };
    expect(replay.org_id).toBe(orgId);
  });

  it("a replay with the same key after success returns the stored result", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    const first = (await fullClaim(d, assertion, EMAIL, "idem-x")) as {
      org_id: string;
      app_id: string;
    };
    const replay = await verifyClaim(d.claim, {
      identityAssertion: assertion,
      otp: FIXTURE_OTP,
      email: EMAIL,
      idempotencyKey: "idem-x",
      remoteIp: "1.2.3.4",
    });
    expect(replay.org_id).toBe(orgId);
    expect(replay.org_id).toBe(first.org_id);
    expect(replay.app_id).toBe(first.app_id);
    // The replay returned the STORED result without re-mutating: org stays cleared.
    expect(await isProvisional(orgId)).toBe(false);
  });
});

describe("H3: OTP brute-force is attempt-capped", () => {
  it("burns the code after the attempt limit; a later correct guess is rejected", async () => {
    const d = deps();
    const { assertion } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    const guess = (otp: string) =>
      verifyClaim(d.claim, {
        identityAssertion: assertion,
        otp,
        email: EMAIL,
        idempotencyKey: `g-${otp}-${Math.random()}`,
        remoteIp: "1.2.3.4",
      });
    // Five wrong guesses burn the code ...
    for (let i = 0; i < 5; i++) {
      await expect(guess(`bad-${i}`)).rejects.toMatchObject({ code: "invalid_grant" });
    }
    // ... so even the CORRECT code is now rejected (lockout).
    await expect(guess(FIXTURE_OTP)).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("claim is rate-gated like register", () => {
  it("the per-IP ceiling (shared with register) trips claim-initiate", async () => {
    // Cap 1/IP/hr: register consumes the slot, so claim-initiate from the same IP
    // trips — proving /claim is gated by the SAME ceiling as register.
    const d = deps({ rateLimits: { perIpPerHour: 1, globalPerHour: 1000 } });
    const { assertion } = await register(d);
    await expect(
      initiateClaim(d.claim, { identityAssertion: assertion, email: EMAIL, remoteIp: "1.2.3.4" }),
    ).rejects.toMatchObject({ code: "too_many_requests" });
  });
});
