import { describe, expect, it } from "vitest";
import {
  assertClaimInitiator,
  claimCompletionKind,
  ClaimCeremonyError,
  postClaimCeremony,
} from "#lib/claims/claim-ceremony";

const request = {
  email: "claim@example.com",
  identityAssertion: "assertion",
  idempotencyKey: "same-key",
  otp: "123456",
};

describe("claim ceremony Auth API bridge", () => {
  it("retains the durable verification identifier across the initiation and verification calls", async () => {
    const requestFn = async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        verification_id: "cver_123",
        idempotency_key: "stable-key",
      });
      return Response.json({
        access_token: "access-token",
        app_id: "app_1",
        org_id: "org_1",
        user_id: "user_1",
      });
    };

    await postClaimCeremony(
      "https://auth.splitch.test",
      { ...request, verificationId: "cver_123", idempotencyKey: "stable-key" },
      requestFn,
    );
  });

  it("reads the durable verification identifier from interaction_required", async () => {
    await expect(
      postClaimCeremony("https://auth.splitch.test", request, async () =>
        Response.json(
          {
            consent_url: "https://app.splitch.test/claim/consent/ccons_123",
            error: "interaction_required",
            error_description: "the email owner must approve linking",
            verification_id: "cver_123",
          },
          { status: 401 },
        ),
      ),
    ).rejects.toMatchObject({ code: "interaction_required", verificationId: "cver_123" });
  });

  it("returns the Worker's completed-claim identity without treating it as a panel success state", async () => {
    const result = await postClaimCeremony("https://auth.splitch.test", request, async () =>
      Response.json({
        access_token: "access-token",
        app_id: "app_1",
        org_id: "org_1",
        user_id: "user_1",
      }),
    );

    expect(result).toMatchObject({ appId: "app_1", orgId: "org_1", userId: "user_1" });
  });

  it("surfaces a Worker actor-binding refusal unchanged", async () => {
    await expect(
      postClaimCeremony("https://auth.splitch.test", request, async () =>
        Response.json(
          {
            error: "invalid_grant",
            error_description: "identity_assertion does not match this claim",
          },
          { status: 400 },
        ),
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "invalid_grant",
        message: "identity_assertion does not match this claim",
      }),
    );
  });

  it("surfaces a replayed already-claimed response instead of silently retrying", async () => {
    await expect(
      postClaimCeremony("https://auth.splitch.test", request, async () =>
        Response.json(
          { error: "invalid_grant", error_description: "workspace is not awaiting a claim" },
          { status: 400 },
        ),
      ),
    ).rejects.toBeInstanceOf(ClaimCeremonyError);
  });

  it("refuses an assertion for a second user before the panel can verify a claim", () => {
    try {
      assertClaimInitiator(
        {
          otpRequired: true,
          verificationId: "cver_attacker",
          userId: "user_attacker",
          orgId: "org_attacker",
        },
        { userId: "user_victim", orgId: "org_victim" },
      );
      throw new Error("expected an actor-binding rejection");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_grant",
        message: "The claim identity does not match this Organization member.",
      });
    }
  });

  it("accepts a completed collision transfer only for the same Organization", () => {
    expect(
      claimCompletionKind(
        { accessToken: "token", appId: "app_1", orgId: "org_1", userId: "user_existing" },
        { orgId: "org_1", userId: "user_provisional" },
      ),
    ).toBe("transferred");
  });
});
