import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

const NOW = "2026-10-25T08:00:00.000Z";
const LATER = "2026-10-26T08:00:00.000Z";
let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;
beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
});
afterEach(async () => local.dispose());

function scope() {
  return envScope(seed.a.appId, seed.a.environmentId);
}
function install(installationId: string) {
  return repo.convex.createInstallation(scope(), {
    installationId,
    callbackUrl: "https://example.convex.site/configuration",
    secretCiphertext: "ciphertext",
    secretKeyVersion: "v1",
    secretFingerprint: "fingerprint",
    now: NOW,
  });
}
async function markMissing(installationId: string, now: string) {
  const token = crypto.randomUUID();
  await local.d1
    .prepare("UPDATE convex_installations SET deployment_probe_token = ? WHERE installation_id = ?")
    .bind(token, installationId)
    .run();
  await repo.convex.markDeploymentMissing(installationId, token, now);
}

async function terminalReceipt(owner: string) {
  const [delivery] = await repo.convex.claimDueDeliveries(
    "2099-01-01T00:00:00.000Z",
    owner,
    "2099-01-02T00:00:00.000Z",
    1,
  );
  if (!delivery) throw new Error("Expected a claimed delivery");
  expect(
    await repo.convex.finishDelivery(delivery.deliveryId, "stale-owner", {
      state: "terminal",
      now: NOW,
    }),
  ).toBeNull();
  const token = await repo.convex.finishDelivery(delivery.deliveryId, owner, {
    state: "terminal",
    now: NOW,
  });
  if (!token) throw new Error("Expected an owned completion receipt");
  return token;
}

async function changeConfig() {
  await local.d1
    .prepare("UPDATE environments SET config_version = config_version + 1 WHERE id = ?")
    .bind(seed.a.environmentId)
    .run();
}
async function rows(installationId: string) {
  return (
    await local.d1
      .prepare(`SELECT state, lease_owner AS leaseOwner, completed_at AS completedAt,
    environment_version AS version, body_json AS bodyJson FROM config_webhook_deliveries
    WHERE installation_id = ? ORDER BY environment_version`)
      .bind(installationId)
      .all<{
        state: string;
        leaseOwner: string | null;
        completedAt: string | null;
        version: number;
        bodyJson: string;
      }>()
  ).results;
}

describe("Convex deployment dormancy on real D1", () => {
  it("atomically suppresses pending and leased deliveries and stops trigger fan-out only for dormant installations", async () => {
    await install("dormant");
    await changeConfig();
    await repo.convex.claimDueDeliveries(
      "2099-01-01T00:00:00.000Z",
      "owner",
      "2099-01-02T00:00:00.000Z",
      1,
    );
    await changeConfig();
    await install("healthy");
    expect((await rows("dormant")).map((row) => row.state)).toEqual(["leased", "pending"]);
    await markMissing("dormant", NOW);
    expect(await repo.convex.getInstallation(scope(), "dormant")).toMatchObject({
      status: "active",
      deploymentMissingAt: NOW,
    });
    expect(await rows("dormant")).toEqual([
      expect.objectContaining({
        state: "suppressed",
        leaseOwner: null,
        completedAt: expect.any(String),
      }),
      expect.objectContaining({
        state: "suppressed",
        leaseOwner: null,
        completedAt: expect.any(String),
      }),
    ]);
    await changeConfig();
    expect(await rows("dormant")).toHaveLength(2);
    expect(await rows("healthy")).toHaveLength(1);
    expect(
      (
        await repo.convex.claimDueDeliveries(
          "2099-01-03T00:00:00.000Z",
          "next",
          "2099-01-04T00:00:00.000Z",
          25,
        )
      ).map((row) => row.installationId),
    ).toEqual(["healthy"]);
  });

  it.each([false, true])(
    "reactivates with an idempotent current-version nudge, existing delivery=%s",
    async (existingDelivery) => {
      await install("dormant");
      await changeConfig();
      await markMissing("dormant", NOW);
      if (!existingDelivery) await changeConfig();
      const version = await repo.convex.environmentVersion(scope());
      await repo.convex.reactivateDeployment(scope(), "dormant", LATER);
      await repo.convex.reactivateDeployment(scope(), "dormant", LATER);
      expect(await repo.convex.getInstallation(scope(), "dormant")).toMatchObject({
        status: "active",
        deploymentMissingAt: null,
      });
      const current = (await rows("dormant")).filter((row) => row.version === version);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({ state: "pending", completedAt: null });
      expect(JSON.parse(current[0]?.bodyJson ?? "null")).toMatchObject({
        environmentVersion: version,
        type: "config.changed",
      });
      await changeConfig();
      expect((await rows("dormant")).at(-1)).toMatchObject({
        version: version + 1,
        state: "pending",
      });
    },
  );

  it("does not mark revoked installations or reactivate revoked or foreign installations", async () => {
    await install("revoked");
    await install("dormant");
    await markMissing("dormant", NOW);
    await repo.convex.revokeInstallation(scope(), "revoked", NOW);
    await markMissing("revoked", NOW);
    await repo.convex.reactivateDeployment(scope(), "revoked", LATER);
    await repo.convex.reactivateDeployment(
      envScope(seed.b.appId, seed.b.environmentId),
      "dormant",
      LATER,
    );
    expect(await repo.convex.getInstallation(scope(), "revoked")).toMatchObject({
      status: "revoked",
      deploymentMissingAt: null,
    });
    expect(await repo.convex.getInstallation(scope(), "dormant")).toMatchObject({
      deploymentMissingAt: NOW,
    });
    expect(await rows("revoked")).toEqual([]);
  });
});

describe("Convex deployment probe receipts on real D1", () => {
  it.each(["check", "reactivation", "newer-terminal"])(
    "rejects an obsolete receipt after %s at the same timestamp",
    async (activity) => {
      await install("guarded");
      await changeConfig();
      const token = await terminalReceipt("owner");
      if (activity === "check") await repo.convex.recordDeploymentCheck("guarded", NOW);
      if (activity === "reactivation") {
        await repo.convex.markDeploymentMissing("guarded", token, NOW);
        await repo.convex.reactivateDeployment(scope(), "guarded", NOW);
      }
      if (activity === "newer-terminal") {
        await changeConfig();
        const nextToken = await terminalReceipt("next");
        expect(nextToken).not.toBe(token);
      }
      await repo.convex.markDeploymentMissing("guarded", token, NOW);
      expect(await repo.convex.getInstallation(scope(), "guarded")).toMatchObject({
        deploymentMissingAt: null,
      });
      await changeConfig();
      expect((await rows("guarded")).at(-1)?.state).toBe("pending");
    },
  );

  it("rotates a bounded batch fairly, including dormant installations older than thirty days", async () => {
    for (const id of ["one", "two", "three"]) {
      await install(id);
      await markMissing(id, "2026-01-01T00:00:00.000Z");
    }
    const first = await repo.convex.dormantDeployments(2);
    for (const row of first) await repo.convex.recordDeploymentCheck(row.installationId, NOW);
    const second = await repo.convex.dormantDeployments(2);
    expect(new Set([...first, ...second].map((row) => row.installationId)).size).toBe(3);
    expect(second[0]?.installationId).not.toBe(first[0]?.installationId);
    expect(await repo.convex.dormantDeployments(10)).toHaveLength(3);
  });
});
