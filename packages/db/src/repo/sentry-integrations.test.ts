import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * The Sentry installation row IS the delivery outbox: `last_delivered_seq` is the
 * only thing standing between "Sentry saw this change" and "Sentry saw it twice
 * or not at all". These tests pin the cursor's advance/hold semantics, and the
 * tenant scoping that keeps one App's webhook secret out of another's reach.
 */

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T00:05:00.000Z";

function install(tenant: "a" | "b", installationId: string) {
  const t = seed[tenant];
  return repo.sentry.createInstallation(envScope(t.appId, t.environmentId), {
    installationId,
    webhookUrl: "https://sentry.io/api/0/organizations/acme/flags/hooks/provider/generic/",
    secretCiphertext: `cipher_${installationId}`,
    secretKeyVersion: "v1",
    secretFingerprint: `fp_${installationId}`,
    now: NOW,
  });
}

describe("sentry installations", () => {
  it("starts with no cursor so a fresh installation replays existing history", async () => {
    const row = await install("a", "sin_a");
    expect(row.lastDeliveredSeq).toBeNull();
    expect(row.status).toBe("active");
    expect(row.nextAttemptAt).toBe(NOW);
  });

  it("refuses a second installation on the same Environment", async () => {
    await install("a", "sin_a");
    // A silent no-op here would leave the caller believing a second Sentry org
    // was wired up while every change still went to the first.
    await expect(install("a", "sin_a_dup")).rejects.toThrow();
  });

  it("frees the Environment once the installation is revoked", async () => {
    await install("a", "sin_a");
    await repo.sentry.revokeInstallation(
      envScope(seed.a.appId, seed.a.environmentId),
      "sin_a",
      LATER,
    );
    await expect(install("a", "sin_a_next")).resolves.toMatchObject({ status: "active" });
  });

  it("does not expose one tenant's installation to another", async () => {
    await install("a", "sin_a");
    const stolen = await repo.sentry.getInstallation(
      envScope(seed.b.appId, seed.b.environmentId),
      "sin_a",
    );
    expect(stolen).toBeNull();
  });

  it("advances the cursor and clears backoff on success", async () => {
    await install("a", "sin_a");
    await repo.sentry.recordSuccess("sin_a", 42, LATER);
    const row = await current();
    expect(row?.lastDeliveredSeq).toBe(42);
    expect(row?.attemptCount).toBe(0);
    expect(row?.latestDeliveryErrorJson).toBeNull();
  });

  it("never rewinds the cursor on a late or out-of-order success", async () => {
    await install("a", "sin_a");
    await repo.sentry.recordSuccess("sin_a", 42, LATER);
    await repo.sentry.recordSuccess("sin_a", 7, LATER);
    // A rewind would redeliver everything between 7 and 42 on the next tick.
    expect((await current())?.lastDeliveredSeq).toBe(42);
  });

  it("holds the cursor on failure so the same batch is retried", async () => {
    await install("a", "sin_a");
    await repo.sentry.recordSuccess("sin_a", 42, NOW);
    await repo.sentry.recordFailure("sin_a", {
      nextAttemptAt: LATER,
      errorJson: '{"status":500}',
      now: NOW,
    });
    const row = await current();
    expect(row?.lastDeliveredSeq).toBe(42);
    expect(row?.attemptCount).toBe(1);
    expect(row?.nextAttemptAt).toBe(LATER);
  });

  it("withholds an installation that is backed off, and returns it once due", async () => {
    await install("a", "sin_a");
    await repo.sentry.recordFailure("sin_a", {
      nextAttemptAt: LATER,
      errorJson: '{"status":500}',
      now: NOW,
    });
    expect(await repo.sentry.dueInstallations(NOW, 10)).toHaveLength(0);
    expect(await repo.sentry.dueInstallations(LATER, 10)).toHaveLength(1);
  });

  it("never dispatches to a revoked installation", async () => {
    await install("a", "sin_a");
    await repo.sentry.revokeInstallation(
      envScope(seed.a.appId, seed.a.environmentId),
      "sin_a",
      NOW,
    );
    expect(await repo.sentry.dueInstallations(LATER, 10)).toHaveLength(0);
  });

  it("reports the laggard's cursor as the retention floor", async () => {
    await install("a", "sin_a");
    await install("b", "sin_b");
    await repo.sentry.recordSuccess("sin_a", 90, LATER);
    await repo.sentry.recordSuccess("sin_b", 12, LATER);
    // Pruning past 12 would silently drop changes B has never seen.
    expect(await repo.sentry.minUndeliveredSeq()).toBe(12);
  });

  it("ignores revoked installations when computing the retention floor", async () => {
    await install("a", "sin_a");
    await install("b", "sin_b");
    await repo.sentry.recordSuccess("sin_a", 90, LATER);
    await repo.sentry.revokeInstallation(
      envScope(seed.b.appId, seed.b.environmentId),
      "sin_b",
      LATER,
    );
    expect(await repo.sentry.minUndeliveredSeq()).toBe(90);
  });

  it("rotates the secret without disturbing the delivery cursor", async () => {
    await install("a", "sin_a");
    await repo.sentry.recordSuccess("sin_a", 42, NOW);
    const rotated = await repo.sentry.rotateSecret(
      envScope(seed.a.appId, seed.a.environmentId),
      "sin_a",
      {
        secretCiphertext: "cipher_rotated",
        secretKeyVersion: "v2",
        secretFingerprint: "fp_rotated",
        rotationId: "rot_1",
        now: LATER,
      },
    );
    expect(rotated).toMatchObject({
      secretCiphertext: "cipher_rotated",
      secretKeyVersion: "v2",
      lastRotationId: "rot_1",
      lastRotationFingerprint: "fp_rotated",
      lastDeliveredSeq: 42,
    });
  });

  it("does not let another tenant rotate the secret", async () => {
    await install("a", "sin_a");
    const rotated = await repo.sentry.rotateSecret(
      envScope(seed.b.appId, seed.b.environmentId),
      "sin_a",
      {
        secretCiphertext: "cipher_stolen",
        secretKeyVersion: "v2",
        secretFingerprint: "fp_stolen",
        rotationId: "rot_evil",
        now: LATER,
      },
    );
    expect(rotated).toBeNull();
    expect((await current())?.secretCiphertext).toBe("cipher_sin_a");
  });
});

function current() {
  return repo.sentry.getInstallation(envScope(seed.a.appId, seed.a.environmentId), "sin_a");
}
