import type { Repository } from "@splitch/db";
import type { ClaimDeps } from "./claim";
import type { Jwks } from "./jwks";
import {
  type IdempotencyStore,
  makeFixtureOtp,
  makeIdempotencyStore,
  type OtpVerifier,
} from "./otp";
import { makeRateLimiter, type RateLimitConfig } from "./rate-limit";
import type { RegisterDeps } from "./register";
import { memoryKvNamespace } from "./test-kv";
import { makeTokenSigner, type TokenSigner } from "./token-exchange";
import { makeFixtureTurnstile } from "./turnstile";
import { makeFixtureWorkOs, type WorkOsPort } from "./workos";

/** The standard test secrets/origins; every door test signs with the same set. */
const TEST_SIGNER_CONFIG = {
  assertionSecret: "test-assertion-secret",
  accessSecret: "test-access-secret",
  issuer: "https://auth.splitch.test",
  controlPlaneAudience: "https://cp.splitch.test",
} as const;

const KID = "fixture-key-1";

export interface FixtureKeypair {
  privateKey: CryptoKey;
  jwks: Jwks;
}

/** Generate an RSA keypair and the matching single-key JWKS. */
export async function makeFixtureKeypair(): Promise<FixtureKeypair> {
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
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    privateKey: pair.privateKey,
    jwks: {
      keys: [{ kty: "RSA", kid: KID, n: pub.n as string, e: pub.e as string, alg: "RS256" }],
    },
  };
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function seg(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Sign a fixture ID-JAG (RS256) with the given claims. */
export async function signIdJag(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
): Promise<string> {
  const input = `${seg({ alg: "RS256", typ: "JWT", kid: KID })}.${seg(claims)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input) as unknown as BufferSource,
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

export interface LocalBindings {
  d1: D1Database;
  kv: KVNamespace;
  sessionKv: KVNamespace;
  dispose: () => Promise<void>;
}

/**
 * Door B (register + claim) deps + the shared fixture handles a test can drive.
 * Wiring the two ceremonies through one set of fixtures (one WorkOS port, one OTP
 * verifier, ONE rate limiter shared by register + claim, one idempotency/turnstile
 * store) mirrors how index.ts shares them so a claim sees the register's user and
 * the OTP it issued. Tests for the OTHER doors call this just to satisfy AppDeps;
 * the Door B test reaches into the returned fixtures (workos, otp, idempotency).
 */
export interface DoorBFixtures {
  repo: Repository;
  register: RegisterDeps;
  claim: ClaimDeps;
  workos: WorkOsPort;
  otp: OtpVerifier;
  idempotency: IdempotencyStore;
  /** The shared signer (assertion + access secrets) the other doors must reuse. */
  tokenSigner: TokenSigner;
}

export function makeDoorBDeps(
  repo: Repository,
  now: () => number,
  opts: {
    consentBaseUrl?: string;
    rateLimits?: RateLimitConfig;
    tokenSigner?: TokenSigner;
    sessionStore?: KVNamespace;
  } = {},
): DoorBFixtures {
  const tokenSigner = opts.tokenSigner ?? makeTokenSigner(TEST_SIGNER_CONFIG);
  const workos = makeFixtureWorkOs();
  const otp = makeFixtureOtp();
  const turnstile = makeFixtureTurnstile();
  const rateLimiter = makeRateLimiter(opts.rateLimits);
  const idempotency = makeIdempotencyStore();
  return {
    repo,
    workos,
    otp,
    idempotency,
    tokenSigner,
    register: { repo, turnstile, rateLimiter, workos, tokenSigner, now },
    claim: {
      repo,
      workos,
      otp,
      idempotency,
      tokenSigner,
      rateLimiter,
      consentBaseUrl: opts.consentBaseUrl ?? "https://cp.splitch.test",
      defaultResource: "https://cp.splitch.test",
      now,
      sessionStore: opts.sessionStore ?? memoryKvNamespace(),
    },
  };
}
