import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { LATER, NOW } from "./delivery-claim-fixture";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

let local: LocalD1;
let seed: SeededTenants;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
  repo = createRepository(local.d1);
});
afterEach(async () => local.dispose());

function install(orgId: string, installationId: string, now = NOW) {
  return repo.sentry.createInstallation(orgId, {
    installationId,
    webhookUrl: "https://sentry.io/api/0/organizations/example/flags/hooks/provider/generic/",
    secretCiphertext: "cipher_synthetic",
    secretKeyVersion: "v1",
    secretFingerprint: "fingerprint",
    now,
  });
}

describe("Sentry pending-event scheduler selection", () => {
  it("finds pending changes behind more than 25 idle Organizations without changing idle state", async () => {
    for (let index = 0; index < 26; index += 1) {
      const orgId = `org_idle_${index}`;
      await local.d1
        .prepare(`INSERT INTO organizations (id, name, slug, plan, created_at, updated_at)
          VALUES (?, ?, ?, 'free', ?, ?)`)
        .bind(orgId, orgId, orgId, NOW, NOW)
        .run();
      await install(orgId, `sentry_idle_${index}`);
    }
    await install(seed.a.orgId, "sentry_pending", LATER);
    const before = await local.d1
      .prepare("SELECT * FROM sentry_installations ORDER BY installation_id")
      .all();
    const rows = await repo.sentry.dueInstallations(LATER, 25);
    expect(rows.map((row) => row.installationId)).toEqual(["sentry_pending"]);
    const after = await local.d1
      .prepare("SELECT * FROM sentry_installations ORDER BY installation_id")
      .all();
    expect(JSON.stringify(after.results)).toBe(JSON.stringify(before.results));
  });

  it("keeps pending events behind a retry deadline and excludes revoked installations", async () => {
    await install(seed.a.orgId, "sentry_a");
    await install(seed.b.orgId, "sentry_b");
    await repo.sentry.recordFailure("sentry_a", {
      nextAttemptAt: LATER,
      errorJson: '{"code":"HTTP_STATUS"}',
      now: NOW,
    });
    await repo.sentry.revokeInstallation(seed.b.orgId, "sentry_b", NOW);
    expect(await repo.sentry.dueInstallations(NOW, 25)).toEqual([]);
    expect(
      (await repo.sentry.dueInstallations(LATER, 25)).map((row) => row.installationId),
    ).toEqual(["sentry_a"]);
  });

  it("never treats another Organization's later event as pending for a consumed cursor", async () => {
    await install(seed.a.orgId, "sentry_a");
    await install(seed.b.orgId, "sentry_b");
    const own = await repo.flagChangeEvents.pendingForOrg(seed.a.orgId, 0, 100);
    const last = own.at(-1);
    if (!last) throw new Error("Sentry fixture has no own event");
    await repo.sentry.recordSuccess("sentry_a", last.seq, NOW);
    const foreign = await repo.flagChangeEvents.pendingForOrg(seed.b.orgId, last.seq, 100);
    expect(foreign.length).toBeGreaterThan(0);
    expect((await repo.sentry.dueInstallations(NOW, 25)).map((row) => row.installationId)).toEqual([
      "sentry_b",
    ]);
    expect((await repo.sentry.getInstallation(seed.a.orgId, "sentry_a"))?.lastDeliveredSeq).toBe(
      last.seq,
    );
  });

  it("includes pending changes from every App and Environment within the Organization", async () => {
    await install(seed.a.orgId, "sentry_a");
    const own = await repo.flagChangeEvents.pendingForOrg(seed.a.orgId, 0, 100);
    const last = own.at(-1);
    if (!last) throw new Error("Sentry fixture has no own event");
    await repo.sentry.recordSuccess("sentry_a", last.seq, NOW);
    await local.d1
      .prepare(`INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
        VALUES ('app_sibling', ?, 'Sibling', 'sibling', ?, ?)`)
      .bind(seed.a.orgId, NOW, NOW)
      .run();
    await local.d1
      .prepare(`INSERT INTO flag_change_events (app_id, environment_id, flag_id, flag_key,
        action, target_type, changed_at)
        VALUES ('app_sibling', NULL, 'flag_sibling', 'sibling', 'created', 'flag', ?)`)
      .bind(NOW)
      .run();
    expect((await repo.sentry.dueInstallations(NOW, 25)).map((row) => row.installationId)).toEqual([
      "sentry_a",
    ]);
    expect(await repo.flagChangeEvents.pendingForOrg(seed.a.orgId, last.seq, 100)).toEqual([
      expect.objectContaining({ appId: "app_sibling", environmentId: null }),
    ]);
  });
});
