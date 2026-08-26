import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T00:05:00.000Z";
const FIRST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
const ACTIVE_INSTALLATION_ID = "00000000-0000-4000-8000-000000000002";
const FOREIGN_INSTALLATION_ID = "00000000-0000-4000-8000-000000000003";
const ENDPOINT =
  "https://splitch-config-production.customer.workers.dev/integrations/splitch/configuration";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => local.dispose());

function install(tenant: "a" | "b", installationId: string, now = NOW) {
  const scope = seed[tenant];
  return repo.cloudflare.createInstallation(envScope(scope.appId, scope.environmentId), {
    installationId,
    endpoint: ENDPOINT,
    secretCiphertext: "ciphertext",
    secretKeyVersion: "v1",
    secretFingerprint: "fingerprint",
    now,
  });
}

describe("Cloudflare integration repository", () => {
  it("creates initial delivery, triggers newer versions, leases, and records apply health", async () => {
    const scope = envScope(seed.a.appId, seed.a.environmentId);
    await install("a", FIRST_INSTALLATION_ID);
    const environmentVersion = await repo.cloudflare.environmentVersion(scope);
    await local.d1
      .prepare(
        "UPDATE environments SET config_version = config_version + 1 WHERE app_id = ? AND id = ?",
      )
      .bind(scope.appId, scope.environmentId)
      .run();

    const leased = await repo.cloudflare.claimDueDeliveries(
      "2099-01-01T00:00:00.000Z",
      "lease-owner",
      "2099-01-01T00:01:00.000Z",
      25,
    );
    expect(leased.map((delivery) => delivery.environmentVersion)).toEqual([environmentVersion + 1]);
    const latest = leased.find(
      (delivery) => delivery.environmentVersion === environmentVersion + 1,
    );
    expect(latest).toBeDefined();
    if (!latest) return;
    await repo.cloudflare.finishDelivery(latest.deliveryId, "lease-owner", {
      state: "delivered",
      now: "2099-01-01T00:00:01.000Z",
      appliedVersion: environmentVersion + 1,
    });
    await repo.cloudflare.finishDelivery(latest.deliveryId, "stale-lease-owner", {
      state: "terminal",
      now: "2099-01-01T00:00:02.000Z",
      errorJson: JSON.stringify({ kind: "transport" }),
    });
    await expect(
      repo.cloudflare.getInstallation(scope, FIRST_INSTALLATION_ID),
    ).resolves.toMatchObject({
      lastAppliedVersion: environmentVersion + 1,
      lastAppliedAt: "2099-01-01T00:00:01.000Z",
      latestDeliveryErrorJson: null,
    });
    await expect(
      repo.cloudflare.deliveryHealth(
        scope,
        FIRST_INSTALLATION_ID,
        Date.parse("2099-01-01T00:00:01.000Z"),
      ),
    ).resolves.toMatchObject({ pendingCount: 0, terminalCount: 0 });
  });

  it("lists active and revoked installation health without crossing tenant scope", async () => {
    const scope = envScope(seed.a.appId, seed.a.environmentId);
    await install("a", FIRST_INSTALLATION_ID);
    await repo.cloudflare.revokeInstallation(scope, FIRST_INSTALLATION_ID, LATER);
    await local.d1
      .prepare("DELETE FROM cloudflare_config_deliveries WHERE installation_id = ?")
      .bind(FIRST_INSTALLATION_ID)
      .run();

    await install("a", ACTIVE_INSTALLATION_ID, LATER);
    await install("b", FOREIGN_INSTALLATION_ID, LATER);
    const environmentVersion = await repo.cloudflare.environmentVersion(scope);
    await local.d1.batch([
      local.d1
        .prepare(
          "UPDATE cloudflare_config_deliveries SET state = 'terminal' WHERE installation_id = ?",
        )
        .bind(ACTIVE_INSTALLATION_ID),
      local.d1
        .prepare(`INSERT INTO cloudflare_config_deliveries (
          delivery_id, installation_id, app_id, environment_id, environment_version,
          state, attempt_count, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`)
        .bind(
          "00000000-0000-4000-8000-000000000004",
          ACTIVE_INSTALLATION_ID,
          scope.appId,
          scope.environmentId,
          environmentVersion + 1,
          NOW,
          NOW,
        ),
    ]);

    const rows = await repo.cloudflare.listInstallations(scope);

    expect(rows.map((row) => row.installationId)).toEqual([
      ACTIVE_INSTALLATION_ID,
      FIRST_INSTALLATION_ID,
    ]);
    expect(rows[0]).toMatchObject({
      appId: seed.a.appId,
      environmentId: seed.a.environmentId,
      status: "active",
      pendingCount: 1,
      terminalCount: 1,
      oldestPendingAgeMs: expect.any(Number),
    });
    expect(rows[1]).toMatchObject({
      appId: seed.a.appId,
      environmentId: seed.a.environmentId,
      status: "revoked",
      pendingCount: 0,
      terminalCount: 0,
      oldestPendingAgeMs: null,
    });
    expect(rows.some((row) => row.installationId === FOREIGN_INSTALLATION_ID)).toBe(false);
  });
});
