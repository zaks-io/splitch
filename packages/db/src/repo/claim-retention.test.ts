import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1";

const NOW = "2026-07-03T08:00:00.000Z";
const EXPIRED = "2026-07-02T08:00:00.000Z";
const FUTURE = "2026-07-04T08:00:00.000Z";

let local: LocalD1;

beforeEach(async () => {
  local = await createLocalD1();
});

afterEach(async () => {
  await local.dispose();
});

describe("Door B claim retention", () => {
  it("deletes expired idempotency first, then consent attempts and verifications in bounded batches", async () => {
    await seedVerification("expired-one");
    await seedVerification("expired-two");
    await seedIdempotency("expired-one", EXPIRED);
    await seedIdempotency("expired-two", FUTURE);

    await expect(
      createRepository(local.d1).claim.purgeExpiredClaimArtifacts({ now: NOW, limit: 1 }),
    ).resolves.toEqual({ idempotency: 1, consentAttempts: 1, verifications: 1 });
    await expectCount("claim_verifications", "expired-one", 0);
    await expectCount("claim_consent_attempts", "consent-expired-one", 0);
    await expectCount("claim_verifications", "expired-two", 1);
    await expectCount("claim_consent_attempts", "consent-expired-two", 1);

    // The 24-hour replay row still references its verification, so it remains
    // until its own expiry instead of violating the FK or shortening replay.
    await expect(
      createRepository(local.d1).claim.purgeExpiredClaimArtifacts({ now: FUTURE, limit: 1 }),
    ).resolves.toEqual({ idempotency: 1, consentAttempts: 1, verifications: 1 });
    await expectCount("claim_verifications", "expired-two", 0);
    await expectCount("claim_consent_attempts", "consent-expired-two", 0);
  });
});

async function seedVerification(id: string): Promise<void> {
  await local.d1
    .prepare(
      `INSERT INTO claim_verifications
       (id, provisional_user_hash, email_hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .bind(id, `${id}-user`, `${id}-email`, EXPIRED, EXPIRED)
    .run();
  await local.d1
    .prepare(
      `INSERT INTO claim_consent_attempts
       (id, verification_id, existing_user_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(`consent-${id}`, id, `${id}-owner`, EXPIRED, EXPIRED)
    .run();
}

async function seedIdempotency(verificationId: string, expiresAt: string): Promise<void> {
  await local.d1
    .prepare(
      `INSERT INTO claim_idempotency
       (key_hash, verification_id, provisional_user_hash, email_hash,
        organization_hash, app_hash, verified_user_hash, completed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `key-${verificationId}`,
      verificationId,
      `${verificationId}-user`,
      `${verificationId}-email`,
      `${verificationId}-org`,
      `${verificationId}-app`,
      `${verificationId}-verified`,
      EXPIRED,
      expiresAt,
    )
    .run();
}

async function expectCount(table: string, id: string, expected: number): Promise<void> {
  const column = table === "claim_verifications" ? "id" : "id";
  const row = await local.d1
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
    .bind(id)
    .first<{ count: number }>();
  expect(row?.count).toBe(expected);
}
