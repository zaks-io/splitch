import { describe, expect, it } from "vitest";
import { initiateClaim, verifyClaim } from "./claim";
import { EMAIL, setupClaimHarness } from "./claim-harness";
import { FIXTURE_OTP } from "./otp";

const { deps, register, isProvisional, count, clearVerificationResource } = setupClaimHarness();

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

  it("reloads a concurrent winner before rejecting a different-resource loser", async () => {
    const d = deps();
    const { assertion, orgId } = await register(d);
    const mcpResource = "https://mcp.splitch.test/mcp";
    const controlPlaneResource = d.claim.defaultResource;
    const first = await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
      resource: mcpResource,
    });
    const second = await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
      resource: controlPlaneResource,
    });
    const getReservation = d.repo.claim.getClaimReservation.bind(d.repo.claim);
    let reservationReads = 0;
    d.repo.claim.getClaimReservation = async (input) => {
      reservationReads += 1;
      return reservationReads <= 2 ? null : getReservation(input);
    };
    let loserReachedReservation: (() => void) | undefined;
    const loserAtReservation = new Promise<void>((resolve) => {
      loserReachedReservation = resolve;
    });
    let winnerCompleted: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      winnerCompleted = resolve;
    });
    let winnerReserved: (() => void) | undefined;
    const reservationWon = new Promise<void>((resolve) => {
      winnerReserved = resolve;
    });
    const reserveClaim = d.repo.claim.reserveClaim.bind(d.repo.claim);
    d.repo.claim.reserveClaim = async (input) => {
      if (input.selectedResource === controlPlaneResource) {
        await reservationWon;
      }
      const reserved = await reserveClaim(input);
      if (input.selectedResource === mcpResource && reserved) {
        winnerReserved?.();
      }
      if (!reserved) {
        loserReachedReservation?.();
        await completed;
      }
      return reserved;
    };
    const completeClaim = d.repo.claim.completeClaim.bind(d.repo.claim);
    d.repo.claim.completeClaim = async (input) => {
      const result = await completeClaim(input);
      winnerCompleted?.();
      return result;
    };
    const confirm = d.workos.confirmEmailVerification.bind(d.workos);
    d.workos.confirmEmailVerification = async (...args) => {
      await loserAtReservation;
      await confirm(...args);
    };
    const baseInput = {
      identityAssertion: assertion,
      otp: FIXTURE_OTP,
      email: EMAIL,
      idempotencyKey: "different-resource-race",
      remoteIp: "1.2.3.4",
    };
    const winner = verifyClaim(d.claim, {
      ...baseInput,
      verificationId: first.verification_id,
      resource: mcpResource,
    });
    const loser = expect(
      verifyClaim(d.claim, {
        ...baseInput,
        verificationId: second.verification_id,
        resource: controlPlaneResource,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    await expect(winner).resolves.toMatchObject({ org_id: orgId });
    await loser;
  });

  it("fails loud when a legacy verification row has no persisted resource", async () => {
    const d = deps();
    const { assertion } = await register(d);
    const verification = await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
    });
    await clearVerificationResource(verification.verification_id);
    let providerConfirmations = 0;
    d.workos.confirmEmailVerification = async () => {
      providerConfirmations += 1;
    };

    await expect(
      verifyClaim(d.claim, {
        identityAssertion: assertion,
        otp: FIXTURE_OTP,
        email: EMAIL,
        idempotencyKey: "legacy-null-resource",
        remoteIp: "1.2.3.4",
        resource: "https://attacker.example/mcp",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(providerConfirmations).toBe(0);
    expect(await count("claim_idempotency")).toBe(0);
  });

  it("rejects a mismatched resource before reconciling provider success", async () => {
    const d = deps();
    const { assertion } = await register(d);
    const mcpResource = "https://mcp.splitch.test/mcp";
    const verification = await initiateClaim(d.claim, {
      identityAssertion: assertion,
      email: EMAIL,
      remoteIp: "1.2.3.4",
      resource: mcpResource,
    });
    const markVerified = d.repo.claim.markVerified.bind(d.repo.claim);
    let interrupt = true;
    d.repo.claim.markVerified = async (input) => {
      if (interrupt) {
        interrupt = false;
        throw new Error("worker interrupted after provider success");
      }
      return markVerified(input);
    };
    const input = {
      identityAssertion: assertion,
      otp: FIXTURE_OTP,
      email: EMAIL,
      idempotencyKey: "resource-before-reconcile",
      remoteIp: "1.2.3.4",
      verificationId: verification.verification_id,
    };

    await expect(verifyClaim(d.claim, { ...input, resource: mcpResource })).rejects.toThrow(
      "worker interrupted",
    );
    let reconciliationReads = 0;
    d.workos.isEmailVerified = async () => {
      reconciliationReads += 1;
      return true;
    };

    await expect(
      verifyClaim(d.claim, { ...input, resource: d.claim.defaultResource }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(reconciliationReads).toBe(0);
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
});
