import { createRepository } from "@splitch/db";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { initiateClaim, verifyClaim } from "./claim";
import { FIXTURE_OTP } from "./otp";
import { registerAnonymous } from "./register";
import { makeTokenSigner, type TokenSigner } from "./token-exchange";
import {
  type DoorBFixtures,
  type LocalBindings,
  makeDoorBDeps,
  makeLocalBindings,
} from "./test-fixtures";

/**
 * Shared Door B claim TEST HARNESS. The claim suite is split across two files
 * (behavioral `claim.test.ts` + security-finding `claim-security.test.ts`) to stay
 * under the 300-line module guard, so the fixture lifecycle + the drive helpers
 * live here once and both files register them — DRY, one canonical harness.
 *
 * Vitest lifecycle hooks are per-file, so `setupClaimHarness()` registers the
 * beforeAll/afterAll/beforeEach for the calling file and returns the accessors a
 * test needs (deps factory + the register/fullClaim/isProvisional helpers).
 */

const NOW_MS = 1_780_000_000_000;
export const EMAIL = "claimer@example.com";

export interface ClaimHarness {
  deps(opts?: Parameters<typeof makeDoorBDeps>[2]): DoorBFixtures;
  /** Register a provisional identity and return its pre-claim assertion + ids. */
  register(d: DoorBFixtures): Promise<{ assertion: string; orgId: string }>;
  /** Drive a full happy ceremony: initiate (sends OTP) then verify (with the code). */
  fullClaim(d: DoorBFixtures, assertion: string, email?: string, key?: string): Promise<unknown>;
  isProvisional(orgId: string): Promise<boolean>;
  count(
    table: "claim_verifications" | "claim_consent_attempts" | "claim_idempotency",
  ): Promise<number>;
  setProvisional(orgId: string, provisional: boolean): Promise<void>;
}

export function setupClaimHarness(): ClaimHarness {
  let local: LocalBindings;
  let signer: TokenSigner;
  // Turnstile is single-use, so each register gets a UNIQUE token — a test that
  // registers twice (e.g. a victim + an attacker workspace) must not reuse one.
  let turnstileSeq = 0;

  beforeAll(async () => {
    local = await makeLocalBindings();
    signer = makeTokenSigner({
      assertionSecret: "test-assertion-secret",
      accessSecret: "test-access-secret",
      issuer: "https://auth.splitch.test",
      controlPlaneAudience: "https://cp.splitch.test",
    });
  });

  afterAll(() => local.dispose());

  beforeEach(async () => {
    for (const t of [
      "environments",
      "claim_idempotency",
      "claim_consent_attempts",
      "claim_verifications",
      "app_memberships",
      "apps",
      "org_memberships",
      "organizations",
    ]) {
      await local.d1.prepare(`DELETE FROM ${t}`).run();
    }
  });

  function deps(opts?: Parameters<typeof makeDoorBDeps>[2]): DoorBFixtures {
    return makeDoorBDeps(createRepository(local.d1), () => NOW_MS, {
      ...opts,
      tokenSigner: signer,
    });
  }

  async function register(d: DoorBFixtures) {
    turnstileSeq += 1;
    const reg = await registerAnonymous(d.register, {
      turnstileToken: `fixture-turnstile-ok-${turnstileSeq}`,
      remoteIp: "1.2.3.4",
    });
    return { assertion: reg.identity_assertion, orgId: reg.org_id };
  }

  async function fullClaim(d: DoorBFixtures, assertion: string, email = EMAIL, key = "idem-1") {
    await initiateClaim(d.claim, { identityAssertion: assertion, email, remoteIp: "1.2.3.4" });
    return verifyClaim(d.claim, {
      identityAssertion: assertion,
      otp: FIXTURE_OTP,
      email,
      idempotencyKey: key,
      remoteIp: "1.2.3.4",
    });
  }

  async function isProvisional(orgId: string): Promise<boolean> {
    const row = await local.d1
      .prepare("SELECT is_provisional FROM organizations WHERE id = ?")
      .bind(orgId)
      .first<{ is_provisional: number }>();
    return row?.is_provisional === 1;
  }

  async function count(
    table: "claim_verifications" | "claim_consent_attempts" | "claim_idempotency",
  ) {
    const row = await local.d1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function setProvisional(orgId: string, provisional: boolean) {
    await local.d1
      .prepare("UPDATE organizations SET is_provisional = ? WHERE id = ?")
      .bind(provisional ? 1 : 0, orgId)
      .run();
  }

  return { deps, register, fullClaim, isProvisional, count, setProvisional };
}
