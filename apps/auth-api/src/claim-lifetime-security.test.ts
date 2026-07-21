import { describe, expect, it } from "vitest";
import { approveClaimConsent, initiateClaim, verifyClaim } from "./claim";
import { EMAIL, setupClaimHarness } from "./claim-harness";
import { FIXTURE_OTP } from "./otp";

const { deps, register, fullClaim, isProvisional } = setupClaimHarness();
const NOW_MS = 1_780_000_000_000;

describe("Door B's 15-minute ceremony lifetime", () => {
  it.each([6, 11, 14])("accepts an OTP retry at minute %i", async (minutes) => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });

    await expect(
      verifyClaim(
        { ...d.claim, now: () => NOW_MS + minutes * 60 * 1000 },
        {
          identityAssertion: assertion,
          otp: FIXTURE_OTP,
          email: EMAIL,
          idempotencyKey: `otp-${minutes}`,
          remoteIp: "1.2.3.4",
        },
      ),
    ).resolves.toMatchObject({ org_id: orgId });
  });

  it.each([6, 11, 14])("accepts an approved-consent retry at minute %i", async (minutes) => {
    const d = deps();
    const owner = await d.workos.resolveOrCreateUser(`owner-${minutes}@example.com`);
    const { assertion, orgId } = await register(d);
    let consent: { extra: { consent_url: string; verification_id: string } } | undefined;
    try {
      await initiateClaim(d.claim, {
        identityAssertion: assertion,
        email: `owner-${minutes}@example.com`,
        remoteIp: "1.2.3.4",
      });
    } catch (cause) {
      consent = cause as typeof consent;
    }
    const minuteClaim = { ...d.claim, now: () => NOW_MS + minutes * 60 * 1000 };
    const attemptId = new URL(consent?.extra.consent_url as string).pathname
      .split("/")
      .at(-1) as string;
    await approveClaimConsent(minuteClaim, attemptId, owner);

    await expect(
      verifyClaim(minuteClaim, {
        identityAssertion: assertion,
        verificationId: consent?.extra.verification_id,
        email: `owner-${minutes}@example.com`,
        idempotencyKey: `consent-${minutes}`,
        remoteIp: "1.2.3.4",
      }),
    ).resolves.toMatchObject({ org_id: orgId, user_id: owner });
    expect(await isProvisional(orgId)).toBe(false);
  });
});

describe("Door B's 24-hour idempotency replay lifetime", () => {
  it("replays a completed reservation while its window is still valid", async () => {
    const d = deps();
    const { assertion, userId, appId, orgId } = await register(d);
    await fullClaim(d, assertion, EMAIL, "replay-within-window");

    const replayAt = NOW_MS + 23 * 60 * 60 * 1000;
    const replayAssertion = await d.tokenSigner.mintIdentityAssertion(
      userId,
      [`app:${appId}:member`],
      "anonymous",
      Math.floor(replayAt / 1000),
    );
    await expect(
      verifyClaim(
        { ...d.claim, now: () => replayAt },
        {
          identityAssertion: replayAssertion,
          email: EMAIL,
          idempotencyKey: "replay-within-window",
          remoteIp: "1.2.3.4",
        },
      ),
    ).resolves.toMatchObject({ org_id: orgId });
  });

  it("rejects a completed reservation after its window expires", async () => {
    const d = deps();
    const { assertion, userId, appId } = await register(d);
    await fullClaim(d, assertion, EMAIL, "replay-after-window");

    const replayAt = NOW_MS + 24 * 60 * 60 * 1000 + 1;
    const replayAssertion = await d.tokenSigner.mintIdentityAssertion(
      userId,
      [`app:${appId}:member`],
      "anonymous",
      Math.floor(replayAt / 1000),
    );
    await expect(
      verifyClaim(
        { ...d.claim, now: () => replayAt },
        {
          identityAssertion: replayAssertion,
          email: EMAIL,
          idempotencyKey: "replay-after-window",
          remoteIp: "1.2.3.4",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});
