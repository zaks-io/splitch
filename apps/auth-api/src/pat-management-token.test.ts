import {
  accessTokenAuthorizationFromClaim,
  PAT_MANAGEMENT_AUTHORIZATION,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { verifyAccessToken } from "./access-token";
import { accessTokenJwks, makeEphemeralAccessTokenPrivateJwk } from "./access-token-key";
import { decodeJwt, verifySignature } from "./jwks";
import { makeTokenSigner } from "./token-exchange";

const options = {
  assertionSecret: "pat-test-assertion-secret",
  accessSecret: "pat-test-access-secret",
  issuer: "https://auth.splitch.test",
  controlPlaneAudience: "https://cp.splitch.test",
};
const NOW = 1_780_000_000;
const authorization = PAT_MANAGEMENT_AUTHORIZATION;

describe("PAT management token guards", () => {
  it("parses the authorization kind without accepting unknown claims", () => {
    expect(accessTokenAuthorizationFromClaim(authorization)).toBe("pat-management");
    expect(accessTokenAuthorizationFromClaim("membership-wide-read")).toBe("membership-wide-read");
    expect(accessTokenAuthorizationFromClaim("pat-management-extra")).toBeUndefined();
    expect(accessTokenAuthorizationFromClaim({ authorization })).toBeUndefined();
  });

  it("assigns distinct jtis to separate browser approvals", async () => {
    const signer = makeTokenSigner(options);
    const mint = () =>
      signer.mintAccessToken("user_step_up", [], "device_flow", NOW, undefined, authorization);
    const first = decodeJwt(await mint()).payload;
    const second = decodeJwt(await mint()).payload;
    expect(first.jti).not.toBe(second.jti);
  });

  it("signs the step-up claims with the published RS256 key contract", async () => {
    const accessSecret = await makeEphemeralAccessTokenPrivateJwk();
    const signer = makeTokenSigner({
      ...options,
      accessSecret,
      accessTokenTrustContract: "rs256-jwks",
    });
    const token = await signer.mintAccessToken(
      "user_step_up",
      [],
      "device_flow",
      NOW,
      undefined,
      authorization,
    );
    const jwks = accessTokenJwks(accessSecret);
    if (!jwks) throw new Error("test signing key has no public JWKS");
    const decoded = decodeJwt(token);
    await expect(verifySignature(decoded, jwks)).resolves.toBeUndefined();
    expect(decoded.payload).toMatchObject({ authorization, scopes: [], iat: NOW, exp: NOW + 300 });
    expect(decoded.payload.jti).toEqual(expect.any(String));
    expect(
      await verifyAccessToken(`Bearer ${token}`, { ...options, accessSecret }, NOW),
    ).toBeNull();
  });

  it.each(["anonymous", "id_jag", "client_credentials"] as const)(
    "refuses direct minting through %s",
    async (door) => {
      await expect(
        makeTokenSigner(options).mintAccessToken(
          "user_step_up",
          [],
          door,
          NOW,
          undefined,
          authorization,
        ),
      ).rejects.toThrow("PAT management tokens require device approval");
    },
  );

  it("refuses selector scopes and a different protected-resource audience", async () => {
    const signer = makeTokenSigner(options);
    await expect(
      signer.mintAccessToken(
        "user_step_up",
        ["app:app_one:owner"],
        "device_flow",
        NOW,
        undefined,
        authorization,
      ),
    ).rejects.toThrow("PAT management tokens require device approval");
    await expect(
      signer.mintAccessToken(
        "user_step_up",
        [],
        "device_flow",
        NOW,
        "https://mcp.splitch.test",
        authorization,
      ),
    ).rejects.toThrow("PAT management tokens require device approval");
  });

  it("refuses identity-assertion exchanges even outside HTTP schema parsing", async () => {
    const signer = makeTokenSigner(options);
    const assertion = await signer.mintIdentityAssertion("user_step_up", [], "anonymous", NOW);
    await expect(
      signer.exchangeForAccessToken(assertion, NOW, undefined, authorization),
    ).rejects.toThrow("PAT management authorization requires a fresh device approval");
  });

  it("refuses a valid step-up token as a generic Auth API bearer", async () => {
    const token = await makeTokenSigner(options).mintAccessToken(
      "user_step_up",
      [],
      "device_flow",
      NOW,
      undefined,
      authorization,
    );
    expect(await verifyAccessToken(`Bearer ${token}`, options, NOW)).toBeNull();
  });
});
