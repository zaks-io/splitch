const DEFAULT_ACCESS_TOKEN_KID = "splitch-access-token";

export interface AccessTokenPublicJwk {
  kty: "RSA";
  kid: string;
  n: string;
  e: string;
  alg: "RS256";
  use: "sig";
}

export interface AccessTokenJwks {
  keys: AccessTokenPublicJwk[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accessTokenKid(jwk: Record<string, unknown>): string {
  return typeof jwk.kid === "string" && jwk.kid.length > 0 ? jwk.kid : DEFAULT_ACCESS_TOKEN_KID;
}

function hasRsaPrivateKeyFields(jwk: Record<string, unknown>): boolean {
  return ["n", "e", "d", "p", "q", "dp", "dq", "qi"].every(
    (field) => typeof jwk[field] === "string" && jwk[field].length > 0,
  );
}

export function accessTokenPrivateJwkFromSecret(secret: string): JsonWebKey | null {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("ACCESS_TOKEN_SECRET JSON is invalid");
  }

  if (!isRecord(parsed) || parsed.kty !== "RSA" || !hasRsaPrivateKeyFields(parsed)) {
    throw new Error("ACCESS_TOKEN_SECRET JSON must be an RSA private JWK");
  }

  return {
    ...parsed,
    kty: "RSA",
    kid: accessTokenKid(parsed),
    alg: "RS256",
    use: "sig",
    key_ops: ["sign"],
    ext: true,
  } as JsonWebKey;
}

export function accessTokenPublicJwkFromSecret(secret: string): AccessTokenPublicJwk | null {
  const privateJwk = accessTokenPrivateJwkFromSecret(secret);
  if (!privateJwk) {
    return null;
  }
  const privateJwkRecord = privateJwk as Record<string, unknown>;
  if (typeof privateJwk.n !== "string" || typeof privateJwk.e !== "string") {
    throw new Error("ACCESS_TOKEN_SECRET RSA private JWK is missing public key fields");
  }
  return {
    kty: "RSA",
    kid: accessTokenKid(privateJwkRecord),
    n: privateJwk.n,
    e: privateJwk.e,
    alg: "RS256",
    use: "sig",
  };
}

export function accessTokenJwks(accessSecret: string): AccessTokenJwks | null {
  const key = accessTokenPublicJwkFromSecret(accessSecret);
  return key ? { keys: [key] } : null;
}

export async function accessTokenSigningKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Prove the secret can sign, not merely that it parses as a JWK.
 *
 * The explicit private-key field check keeps validation consistent across
 * WebCrypto implementations. Importing then asks the same runtime the signer
 * uses whether the complete key is usable.
 */
export async function assertAccessTokenSecretCanSign(secret: string): Promise<void> {
  const jwk = accessTokenPrivateJwkFromSecret(secret);
  if (!jwk) {
    throw new Error(
      "ACCESS_TOKEN_SECRET must be an exported RSA private JWK (JSON), not an opaque string",
    );
  }
  try {
    await accessTokenSigningKey(jwk);
  } catch (cause) {
    throw new Error(
      "ACCESS_TOKEN_SECRET is not an importable RS256 signing key; export the full private JWK including its CRT parameters (p, q, dp, dq, qi)",
      { cause },
    );
  }
}

export async function makeEphemeralAccessTokenPrivateJwk(): Promise<string> {
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
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify({
    ...privateJwk,
    kid: "splitch-local-access-token",
    alg: "RS256",
    use: "sig",
  });
}
