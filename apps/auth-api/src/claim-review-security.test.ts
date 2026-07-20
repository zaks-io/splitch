import { describe, expect, it } from "vitest";
import { approveClaimConsent, initiateClaim, verifyClaim } from "./claim";
import { EMAIL, setupClaimHarness } from "./claim-harness";
import { FIXTURE_OTP } from "./otp";

const { deps, register, fullClaim, isProvisional, count, removeMemberships, isConsumed } =
  setupClaimHarness();
const NOW_SECONDS = Math.floor(1_780_000_000_000 / 1000);

type ConsentError = {
  extra: { consent_url: string; verification_id: string };
};

describe("SPL-137 security review regressions", () => {
  it("requires the signed provisional User's Org and App memberships", async () => {
    const d = deps();
    const victim = await register(d);
    const other = await register(d);
    const assertion = await d.tokenSigner.mintIdentityAssertion(
      victim.userId,
      [`app:${other.appId}:member`],
      "anonymous",
      NOW_SECONDS,
    );

    await expect(
      initiateClaim(d.claim, {
        identityAssertion: assertion,
        email: EMAIL,
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await isProvisional(other.orgId)).toBe(true);
    expect(await count("claim_verifications")).toBe(0);
  });

  it("does not consume verification, consent, or idempotency state on zero-row transfer", async () => {
    const d = deps();
    const owner = await d.workos.resolveOrCreateUser("owner@example.com");
    const provisional = await register(d);
    let consentError: ConsentError | undefined;
    try {
      await initiateClaim(d.claim, {
        identityAssertion: provisional.assertion,
        email: "owner@example.com",
        remoteIp: "1.2.3.4",
      });
    } catch (cause) {
      consentError = cause as ConsentError;
    }
    const consent = consentError as ConsentError;
    const attemptId = consent.extra.consent_url.split("/").at(-1) as string;
    await approveClaimConsent(d.claim, attemptId, owner);
    await removeMemberships(provisional.orgId, provisional.appId, provisional.userId);

    await expect(
      verifyClaim(d.claim, {
        identityAssertion: provisional.assertion,
        verificationId: consent.extra.verification_id,
        email: "owner@example.com",
        idempotencyKey: "zero-row",
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await isProvisional(provisional.orgId)).toBe(true);
    expect(await isConsumed("claim_verifications", consent.extra.verification_id)).toBe(false);
    expect(await isConsumed("claim_consent_attempts", attemptId)).toBe(false);
    expect(await count("claim_idempotency")).toBe(0);
  });

  it("binds completed idempotency to App for a same-User second session", async () => {
    const d = deps();
    const provisional = await register(d);
    await fullClaim(d, provisional.assertion, EMAIL, "same-key");
    const secondAppId = "app_second_session";
    await d.repo.identity.createApp({
      id: secondAppId,
      organizationId: provisional.orgId,
      name: "Second session app",
      key: secondAppId,
      createdAt: new Date(1_780_000_000_000).toISOString(),
      updatedAt: new Date(1_780_000_000_000).toISOString(),
      createdBy: provisional.userId,
    });
    await d.repo.identity.createAppMembership({
      appId: secondAppId,
      userId: provisional.userId,
      role: "owner",
      createdAt: new Date(1_780_000_000_000).toISOString(),
    });
    const secondSession = await d.tokenSigner.mintIdentityAssertion(
      provisional.userId,
      [`app:${secondAppId}:member`],
      "anonymous",
      NOW_SECONDS,
    );

    await expect(
      verifyClaim(d.claim, {
        identityAssertion: secondSession,
        otp: FIXTURE_OTP,
        email: EMAIL,
        idempotencyKey: "same-key",
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await count("claim_idempotency")).toBe(1);
  });

  it("uses unique acquisition ownership under a fixed clock and different keys", async () => {
    const d = deps();
    const provisional = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: provisional.assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    const attempt = (idempotencyKey: string) =>
      verifyClaim(d.claim, {
        identityAssertion: provisional.assertion,
        otp: FIXTURE_OTP,
        email: EMAIL,
        idempotencyKey,
        remoteIp: "1.2.3.4",
      });

    const settled = await Promise.allSettled([attempt("key-a"), attempt("key-b")]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "invalid_grant" } });
    expect(await count("claim_idempotency")).toBe(1);
    expect(await isProvisional(provisional.orgId)).toBe(false);
  });

  it("builds consent URLs from the explicit Control Panel origin", async () => {
    const d = deps({ consentBaseUrl: "https://app.splitch.test" });
    await d.workos.resolveOrCreateUser("url-owner@example.com");
    const provisional = await register(d);

    await expect(
      initiateClaim(d.claim, {
        identityAssertion: provisional.assertion,
        email: "url-owner@example.com",
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({
      extra: { consent_url: expect.stringMatching(/^https:\/\/app\.splitch\.test\//) },
    });
  });
});
