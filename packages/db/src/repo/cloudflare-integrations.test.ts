import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";

const NOW = "2026-08-25T00:00:00.000Z";
const SCOPE = envScope("app_cloudflare_repo", "env_cloudflare_repo");
const INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeAll(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  await local.d1.batch([
    local.d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES ('org_cloudflare_repo', 'Cloudflare Repo', 'cloudflare-repo', 'free', ?, ?)",
      )
      .bind(NOW, NOW),
    local.d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, 'org_cloudflare_repo', 'Cloudflare App', 'cloudflare-app', ?, ?)",
      )
      .bind(SCOPE.appId, NOW, NOW),
    local.d1
      .prepare(
        "INSERT INTO environments (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, 'production', 'Production', ?, ?)",
      )
      .bind(SCOPE.environmentId, SCOPE.appId, NOW, NOW),
  ]);
});

afterAll(async () => local.dispose());

describe("Cloudflare integration repository", () => {
  it("creates initial delivery, triggers newer versions, leases, and records apply health", async () => {
    await repo.cloudflare.createInstallation(SCOPE, {
      installationId: INSTALLATION_ID,
      endpoint:
        "https://splitch-config-production.customer.workers.dev/integrations/splitch/configuration",
      secretCiphertext: "ciphertext",
      secretKeyVersion: "v1",
      secretFingerprint: "fingerprint",
      now: NOW,
    });
    await local.d1
      .prepare(
        "UPDATE environments SET config_version = config_version + 1 WHERE app_id = ? AND id = ?",
      )
      .bind(SCOPE.appId, SCOPE.environmentId)
      .run();

    const leased = await repo.cloudflare.claimDueDeliveries(
      "2099-01-01T00:00:00.000Z",
      "lease-owner",
      "2099-01-01T00:01:00.000Z",
      25,
    );
    expect(leased.map((delivery) => delivery.environmentVersion)).toEqual([1]);
    const latest = leased.find((delivery) => delivery.environmentVersion === 1);
    expect(latest).toBeDefined();
    if (!latest) return;
    await repo.cloudflare.finishDelivery(latest.deliveryId, "lease-owner", {
      state: "delivered",
      now: "2099-01-01T00:00:01.000Z",
      appliedVersion: 1,
    });
    await repo.cloudflare.finishDelivery(latest.deliveryId, "stale-lease-owner", {
      state: "terminal",
      now: "2099-01-01T00:00:02.000Z",
      errorJson: JSON.stringify({ kind: "transport" }),
    });
    await expect(repo.cloudflare.getInstallation(SCOPE, INSTALLATION_ID)).resolves.toMatchObject({
      lastAppliedVersion: 1,
      lastAppliedAt: "2099-01-01T00:00:01.000Z",
      latestDeliveryErrorJson: null,
    });
    await expect(
      repo.cloudflare.deliveryHealth(
        SCOPE,
        INSTALLATION_ID,
        Date.parse("2099-01-01T00:00:01.000Z"),
      ),
    ).resolves.toMatchObject({ pendingCount: 0, terminalCount: 0 });
  });
});
