import type { Repository } from "@splitch/db";
import { Miniflare } from "miniflare";
import type { ClaimDeps } from "./claim.js";
import type { Jwks } from "./jwks.js";
import {
  type IdempotencyStore,
  makeFixtureOtp,
  makeIdempotencyStore,
  type OtpVerifier,
} from "./otp.js";
import { makeRateLimiter, type RateLimitConfig } from "./rate-limit.js";
import type { RegisterDeps } from "./register.js";
import { makeTokenSigner, type TokenSigner } from "./token-exchange.js";
import { makeFixtureTurnstile } from "./turnstile.js";
import { makeFixtureWorkOs, type WorkOsPort } from "./workos.js";

/** The standard test secrets/origins; every door test signs with the same set. */
const TEST_SIGNER_CONFIG = {
  assertionSecret: "test-assertion-secret",
  accessSecret: "test-access-secret",
  issuer: "https://auth.splitch.test",
  controlPlaneAudience: "https://cp.splitch.test",
} as const;

/**
 * Local FIXTURE substrate for the auth-door tests — no real IdP, no real WorkOS.
 *
 * - A throwaway RSA keypair signs fixture ID-JAG tokens; its public half is the
 *   fixture JWKS the verifier checks against (so signature verification is REAL,
 *   just against a key we control).
 * - A Miniflare local D1 carries only the tables the doors touch (trusted_idps,
 *   organizations, org_memberships, apps, app_memberships, environments — Door B
 *   provisions the latter three); the full migration set is gated by @splitch/db's
 *   own suite, so the door test stays self-contained.
 * - A Miniflare local KV backs the jti replay cache.
 *
 * NO real secrets: everything here is generated at test time and discarded.
 */

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

const SCHEMA = [
  `CREATE TABLE trusted_idps (idp_id TEXT PRIMARY KEY NOT NULL, org_id TEXT, issuer TEXT NOT NULL, jwks_uri TEXT NOT NULL, client_ids TEXT NOT NULL, enabled INTEGER DEFAULT 1 NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX trusted_idps_org_issuer_unique ON trusted_idps (org_id, issuer)`,
  `CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, plan TEXT DEFAULT 'free' NOT NULL, stripe_customer_id TEXT, stripe_subscription_id TEXT, sso_enabled INTEGER DEFAULT 0 NOT NULL, is_provisional INTEGER DEFAULT 0 NOT NULL, demo_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE org_memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id))`,
  `CREATE TABLE apps (id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX apps_org_key_unique ON apps (organization_id, key)`,
  `CREATE TABLE app_memberships (app_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (app_id, user_id))`,
  `CREATE TABLE environments (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE UNIQUE INDEX environments_app_key_unique ON environments (app_id, key)`,
];

export interface LocalBindings {
  d1: D1Database;
  kv: KVNamespace;
  sessionKv: KVNamespace;
  dispose: () => Promise<void>;
}

/** Spin up a fresh local D1 (door tables) + KV (jti cache). */
export async function makeLocalBindings(): Promise<LocalBindings> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
    kvNamespaces: { JTI_CACHE: "jti", SESSION_STORE: "sessions" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  const kv = (await mf.getKVNamespace("JTI_CACHE")) as unknown as KVNamespace;
  const sessionKv = (await mf.getKVNamespace("SESSION_STORE")) as unknown as KVNamespace;
  for (const statement of SCHEMA) {
    await d1.exec(statement);
  }
  return { d1, kv, sessionKv, dispose: () => mf.dispose() };
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
  opts: { consentBaseUrl?: string; rateLimits?: RateLimitConfig; tokenSigner?: TokenSigner } = {},
): DoorBFixtures {
  const tokenSigner = opts.tokenSigner ?? makeTokenSigner(TEST_SIGNER_CONFIG);
  const workos = makeFixtureWorkOs();
  const otp = makeFixtureOtp();
  const turnstile = makeFixtureTurnstile();
  const rateLimiter = makeRateLimiter(opts.rateLimits);
  const idempotency = makeIdempotencyStore();
  return {
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
      now,
    },
  };
}
