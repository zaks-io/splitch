import { describe, expect, it } from "vitest";
import { initiateClaim, verifyClaim } from "./claim";
import { EMAIL, setupClaimHarness } from "./claim-harness";
import { FIXTURE_OTP } from "./otp";

const { deps, register, fullClaim, isProvisional, count } = setupClaimHarness();

describe("claim reservation security", () => {
  it("wrong OTP releases the reservation; a correct retry with the same key succeeds", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });

    await expect(
      verifyClaim(d.claim, {
        identityAssertion: assertion,
        otp: "999999",
        email: EMAIL,
        idempotencyKey: "retry-key",
        remoteIp: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

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

  it("reserves before WorkOS confirmation: one winner and one invalid_request loser", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    let unblockConfirmation: (() => void) | undefined;
    let confirmationStarted: (() => void) | undefined;
    const originalConfirm = d.workos.confirmEmailVerification.bind(d.workos);
    d.workos.confirmEmailVerification = async (...args) => {
      confirmationStarted?.();
      await new Promise<void>((resolve) => {
        unblockConfirmation = resolve;
      });
      await originalConfirm(...args);
    };
    const input = {
      identityAssertion: assertion,
      otp: FIXTURE_OTP,
      email: EMAIL,
      idempotencyKey: "race-2",
      remoteIp: "1.2.3.4",
    };
    const started = new Promise<void>((resolve) => {
      confirmationStarted = resolve;
    });
    const winner = verifyClaim(d.claim, input);
    await started;
    await expect(verifyClaim(d.claim, input)).rejects.toMatchObject({ code: "invalid_request" });
    unblockConfirmation?.();
    await expect(winner).resolves.toMatchObject({ org_id: orgId });
    expect(await isProvisional(orgId)).toBe(false);
  });

  it("allows unrelated Organizations to reuse an idempotency key", async () => {
    const d = deps();
    const first = await register(d);
    const second = await register(d);
    await fullClaim(d, first.assertion, "first@example.com", "shared-across-orgs");
    await fullClaim(d, second.assertion, "second@example.com", "shared-across-orgs");
    expect(await count("claim_idempotency")).toBe(2);
    expect(await isProvisional(first.orgId)).toBe(false);
    expect(await isProvisional(second.orgId)).toBe(false);
  });
});
