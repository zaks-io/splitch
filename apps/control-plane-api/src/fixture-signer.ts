import type { Jwks } from "./jwks-verify";

/**
 * Fixture RS256 signer for the auth-middleware tests.
 *
 * The real control-plane token is RS256-signed by the auth-api and verified
 * against its JWKS. Tests must NOT reach the network or hold a real key, so this
 * fixture mints a local RSA keypair, signs tokens with the private half, and
 * exposes the public half as a JWKS the JwksVerifier consumes through its
 * injected fetcher. The verifier under test runs the SAME RS256 path it runs in
 * production — only the key source is local.
 *
 * Lives in `src` (not a `.test.ts`) so the integration suite imports it; it is
 * not re-exported from the Worker entry and never reaches the production bundle.
 */

const KID = "fixture-control-plane-key";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeSegment(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export interface FixtureSigner {
  /** JWKS document carrying the public key — feed this to the verifier's fetcher. */
  jwks: Jwks;
  /** Sign a JWT with the given claims (RS256, fixture kid). */
  sign(claims: Record<string, unknown>): Promise<string>;
  /** Sign an exact payload so malformed-claim tests still exercise a valid signature. */
  signPayload(payload: unknown): Promise<string>;
}

export async function makeFixtureSigner(): Promise<FixtureSigner> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as {
    kty: string;
    n: string;
    e: string;
  };

  const signPayload = async (payload: unknown): Promise<string> => {
    const signingInput = `${encodeSegment({ alg: "RS256", typ: "JWT", kid: KID })}.${encodeSegment(payload)}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(signingInput) as unknown as BufferSource,
    );
    return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
  };

  return {
    jwks: { keys: [{ kty: publicJwk.kty, kid: KID, n: publicJwk.n, e: publicJwk.e }] },
    sign(claims) {
      return signPayload({ typ: "access_token", ...claims });
    },
    signPayload,
  };
}
