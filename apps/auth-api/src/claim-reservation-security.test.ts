import { describe, expect, it } from "vitest";
import { initiateClaim, verifyClaim } from "./claim";
import { EMAIL, setupClaimHarness } from "./claim-harness";
import { FIXTURE_OTP } from "./otp";
import { makeRateLimiter } from "./rate-limit";

const { deps, register, fullClaim, isProvisional, count } = setupClaimHarness();

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: the reservation race cases share one fixture lifecycle.
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

  it("reconciles a provider success when marking D1 verification fails", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    const confirm = d.workos.confirmEmailVerification.bind(d.workos);
    let confirmations = 0;
    d.workos.confirmEmailVerification = async (...args) => {
      confirmations += 1;
      await confirm(...args);
    };
    const markVerified = d.repo.claim.markVerified.bind(d.repo.claim);
    let failMark = true;
    d.repo.claim.markVerified = async (input) => {
      if (failMark) {
        failMark = false;
        throw new Error("D1 unavailable after provider success");
      }
      return markVerified(input);
    };
    const input = {
      identityAssertion: assertion,
      otp: FIXTURE_OTP,
      email: EMAIL,
      idempotencyKey: "recover-d1-failure",
      remoteIp: "1.2.3.4",
    };

    await expect(verifyClaim(d.claim, input)).rejects.toThrow("D1 unavailable");
    await expect(verifyClaim(d.claim, input)).resolves.toMatchObject({ org_id: orgId });
    expect(confirmations).toBe(1);
    expect(await isProvisional(orgId)).toBe(false);
  });

  it("reconciles an interruption after provider success without releasing its winner", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    const markVerified = d.repo.claim.markVerified.bind(d.repo.claim);
    let interrupted = true;
    d.repo.claim.markVerified = async (input) => {
      if (interrupted) {
        interrupted = false;
        throw new Error("worker interrupted after WorkOS confirmation");
      }
      return markVerified(input);
    };
    const input = {
      identityAssertion: assertion,
      otp: FIXTURE_OTP,
      email: EMAIL,
      idempotencyKey: "recover-interruption",
      remoteIp: "1.2.3.4",
    };

    await expect(verifyClaim(d.claim, input)).rejects.toThrow("worker interrupted");
    await expect(verifyClaim(d.claim, input)).resolves.toMatchObject({ org_id: orgId });
    expect(await isProvisional(orgId)).toBe(false);
  });

  it("does not rate-limit a completed retry or an in-flight same-key loser", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    d.claim.rateLimiter = makeRateLimiter({ perIpPerHour: 1, globalPerHour: 1 });
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
      idempotencyKey: "quota-boundary",
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
    await expect(verifyClaim(d.claim, input)).resolves.toMatchObject({ org_id: orgId });
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
