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

  if (
    !isRecord(parsed) ||
    parsed.kty !== "RSA" ||
    typeof parsed.n !== "string" ||
    typeof parsed.e !== "string" ||
    typeof parsed.d !== "string"
  ) {
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
    kid:
      typeof privateJwkRecord.kid === "string" && privateJwkRecord.kid.length > 0
        ? privateJwkRecord.kid
        : DEFAULT_ACCESS_TOKEN_KID,
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
