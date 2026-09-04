import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEphemeralAccessTokenPrivateJwk } from "./access-token-key";
import type { AuthApiEnv } from "./env";
import worker, { committedAssertionSigningSecrets } from "./index";
import { makePoolBindings } from "./test-bindings-pool";
import type { LocalBindings } from "./test-fixtures";
import { makeTokenSigner } from "./token-exchange";

/**
 * Independent-review reproduction: a hosted Worker that inherited
 * `test-assertion-secret` accepted a forged identity_assertion (`sub` +
 * `scopes` chosen by the attacker) and minted an RS256 access token.
 */

let local: LocalBindings;
let hostedAccessTokenSecret: string;
let hostedAssertionSigningSecret: string;
let hostedEnv: AuthApiEnv;

beforeAll(async () => {
  hostedAccessTokenSecret = await makeEphemeralAccessTokenPrivateJwk();
  hostedAssertionSigningSecret = `hosted-uncommitted-${crypto.randomUUID()}`;
  local = await makePoolBindings();
  hostedEnv = {
    DB: local.d1,
    JTI_CACHE: local.kv,
    SESSION_STORE: local.sessionKv,
    AUTH_API_ORIGIN: "https://auth.splitch.test",
    CONTROL_PLANE_ORIGIN: "https://cp.splitch.test",
    CONTROL_PANEL_ORIGIN: "https://app.splitch.test",
    SPLITCH_PLATFORM_TARGET: "production",
    SPLITCH_DEPLOYED_COMMIT_SHA: "a".repeat(40),
    WORKOS_API_KEY: "test-workos-api-key",
    WORKOS_CLIENT_ID: "test-workos-client-id",
    WORKOS_JWKS_URI: "https://api.workos.test/jwks",
    WORKOS_ISSUER: "https://api.workos.test",
    TURNSTILE_SECRET: "test-turnstile-secret",
    ACCESS_TOKEN_SECRET: hostedAccessTokenSecret,
    ASSERTION_SIGNING_SECRET: hostedAssertionSigningSecret,
  };
});

afterAll(() => local.dispose());

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function forgeAssertion(secret: string): Promise<string> {
  const forger = makeTokenSigner({
    assertionSecret: secret,
    accessSecret: hostedAccessTokenSecret,
    accessTokenTrustContract: "rs256-jwks",
    issuer: "https://auth.splitch.test",
    controlPlaneAudience: "https://cp.splitch.test",
  });
  return forger.mintIdentityAssertion(
    "user_forged",
    ["org:any:owner", "app:any:owner"],
    "anonymous",
    Math.floor(Date.now() / 1000),
  );
}

async function exchangeAssertion(
  identityAssertion: string,
  requestEnv: AuthApiEnv,
): Promise<{ assertionAccepted: boolean; accessMinted: boolean }> {
  const request = new Request("https://auth.splitch.test/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      identity_assertion: identityAssertion,
    }),
  });
  const res = await worker.fetch(
    request as unknown as Parameters<typeof worker.fetch>[0],
    requestEnv,
    testCtx,
  );
  const body: unknown = await res.json();
  return {
    assertionAccepted: res.status === 200,
    accessMinted:
      typeof body === "object" &&
      body !== null &&
      "access_token" in body &&
      typeof body.access_token === "string",
  };
}

describe("hosted committed-secret assertion forgery fails closed", () => {
  it.each(committedAssertionSigningSecrets)(
    "fails closed when hosted inherits committed secret %s",
    async (secret) => {
      const result = await exchangeAssertion(await forgeAssertion(secret), {
        ...hostedEnv,
        ASSERTION_SIGNING_SECRET: secret,
      });
      expect(result).toEqual({ assertionAccepted: false, accessMinted: false });
    },
  );

  it.each(committedAssertionSigningSecrets)(
    "rejects a %s-signed forgery on a uniquely keyed hosted target",
    async (secret) => {
      const result = await exchangeAssertion(await forgeAssertion(secret), hostedEnv);
      expect(result).toEqual({ assertionAccepted: false, accessMinted: false });
    },
  );

  it("still mints when the assertion is signed by the unique hosted secret", async () => {
    const result = await exchangeAssertion(
      await forgeAssertion(hostedAssertionSigningSecret),
      hostedEnv,
    );
    expect(result).toEqual({ assertionAccepted: true, accessMinted: true });
  });
});
