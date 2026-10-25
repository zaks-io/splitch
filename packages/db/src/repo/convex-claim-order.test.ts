import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, type Repository } from "../index";
import { claim, insertDelivery, insertInstallation, NOW } from "./delivery-claim-fixture";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

let local: LocalD1;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});
afterEach(async () => local.dispose());

describe("Convex claim order", () => {
  it("lets healthy Convex installations pass failing ones that began waiting up to 30 minutes earlier", async () => {
    await insertWaitingDelivery("healthy", 1, NOW);
    await insertWaitingDelivery("failing_recent", 1, "2026-08-24 23:31:00", true);
    await insertWaitingDelivery("failing_overdue", 1, "2026-08-24 23:29:00", true);
    expect(await claimOrder(3)).toEqual(["failing_overdue", "healthy", "failing_recent"]);
  });

  it("keeps a failing Convex installation's wait when newer versions arrive", async () => {
    await insertWaitingDelivery("recovering", 1, "2026-08-24 23:29:00", true);
    await insertWaitingDelivery("recovering", 2, NOW, true);
    await insertWaitingDelivery("healthy", 1, NOW);
    const rows = await claim(createRepository(local.d1), "convex", "owner", 1);
    expect(
      rows.map(({ installationId, environmentVersion }) => ({
        installationId,
        environmentVersion,
      })),
    ).toEqual([{ installationId: "recovering", environmentVersion: 2 }]);
  });

  it("keeps both healthy churn and a repeatedly failing Convex installation progressing", async () => {
    await insertWaitingDelivery("recovering", 1, NOW, true);
    const repo = createRepository(local.d1);
    const recoveringClaims: number[] = [];
    for (let minute = 0; minute <= 95; minute++) {
      const tick = new Date(Date.parse(NOW) + minute * 60_000).toISOString();
      await insertWaitingDelivery("healthy", minute + 1, tick);
      await insertWaitingDelivery("recovering", minute + 2, tick, true);
      const row = await claimOne(repo, `tick-${minute}`, tick);
      if (row.installationId === "recovering") recoveringClaims.push(minute);
      await settleChurnTick(repo, row, `tick-${minute}`, tick, recoveringClaims.length);
    }
    expect(recoveringClaims).toEqual([31, 62, 93]);
  });
});

async function insertWaitingDelivery(
  installationId: string,
  version: number,
  createdAt: string,
  failing = false,
) {
  const exists = await local.d1
    .prepare("SELECT 1 FROM convex_installations WHERE installation_id = ?")
    .bind(installationId)
    .first();
  if (!exists) {
    await insertInstallation(local.d1, seed, "convex", installationId);
    await local.d1
      .prepare("UPDATE convex_installations SET updated_at = ? WHERE installation_id = ?")
      .bind(createdAt, installationId)
      .run();
  }
  const { deliveryId } = await insertDelivery(local.d1, seed, "convex", installationId, version);
  await local.d1
    .prepare("UPDATE config_webhook_deliveries SET created_at = ? WHERE delivery_id = ?")
    .bind(createdAt, deliveryId)
    .run();
  if (failing)
    await local.d1
      .prepare(`UPDATE convex_installations SET latest_delivery_error_json = '{"code":"HTTP_STATUS"}'
        WHERE installation_id = ?`)
      .bind(installationId)
      .run();
}

async function claimOrder(ticks: number) {
  const repo = createRepository(local.d1);
  const order: string[] = [];
  for (let tick = 0; tick < ticks; tick++)
    order.push(
      ...(await claim(repo, "convex", `tick-${tick}`, 1)).map((row) => row.installationId),
    );
  return order;
}

async function claimOne(repo: Repository, owner: string, tick: string) {
  const leaseExpiresAt = new Date(Date.parse(tick) + 30_000).toISOString();
  const [row] = await claim(repo, "convex", owner, 1, tick, leaseExpiresAt);
  if (!row) throw new Error(`${owner} claimed nothing`);
  return row;
}

/** Healthy deliveries succeed; the recovering installation alternates a 500 and a cooldown. */
function settleChurnTick(
  repo: Repository,
  row: { deliveryId: string; installationId: string },
  owner: string,
  tick: string,
  recoveringAttempts: number,
) {
  if (row.installationId === "healthy")
    return repo.convex.finishDelivery(row.deliveryId, owner, { state: "delivered", now: tick });
  if (recoveringAttempts % 2 === 1)
    return repo.convex.finishDelivery(row.deliveryId, owner, {
      state: "pending",
      now: tick,
      nextAttemptAt: tick,
      errorJson: '{"code":"HTTP_STATUS","httpStatus":500}',
    });
  return repo.convex.deferPreparationFailure("recovering", owner, {
    secretCiphertext: "cipher_old",
    secretKeyVersion: "v1",
    now: tick,
    retryAt: new Date(Date.parse(tick) + 30 * 60_000).toISOString(),
    errorJson: '{"code":"DELIVERY_PREPARATION_FAILED"}',
  });
}
