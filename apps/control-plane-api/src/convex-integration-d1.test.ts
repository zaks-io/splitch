import { createRepository, envScope } from "@splitch/db";
import { createLocalD1 } from "@splitch/db/test-d1";
import { describe, expect, it, vi } from "vitest";
import {
  loadConvexExposureVerificationConfig,
  loadConvexExposureVerificationConfigs,
} from "./convex-exposure-verification";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one seeded D1 lifecycle proves delivery triggers and immutable verification read the same committed snapshot.
describe("Convex integration D1 transaction", () => {
  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: splitting this transaction would duplicate a large relational fixture and weaken the commit-boundary proof.
  it("increments the Environment version and enqueues one delivery with the config commit", async () => {
    const local = await createLocalD1();
    try {
      const now = "2026-08-25T12:00:00.000Z";
      await local.d1.batch([
        local.d1
          .prepare(
            "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind("org_1", "Org", "org", "free", now, now),
        local.d1
          .prepare(
            "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind("app_1", "org_1", "App", "app", now, now),
        local.d1
          .prepare(
            "INSERT INTO environments (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind("env_1", "app_1", "dev", "Development", now, now),
        local.d1
          .prepare(
            "INSERT INTO flags (id, app_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind("flag_1", "app_1", "checkout", "Checkout", now, now),
      ]);
      const repo = createRepository(local.d1);
      await repo.convex.createInstallation(envScope("app_1", "env_1"), {
        installationId: "00000000-0000-4000-8000-000000000001",
        callbackUrl: "https://example.convex.site/integrations/splitch/configuration",
        secretCiphertext: "ciphertext",
        secretKeyVersion: "v1",
        secretFingerprint: "fingerprint",
        now,
      });

      await local.d1
        .prepare(
          "INSERT INTO flag_configs (id, app_id, environment_id, flag_id, enabled, available_variant_names, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("config_1", "app_1", "env_1", "flag_1", 1, "[]", now, now)
        .run();

      expect(await repo.convex.environmentVersion(envScope("app_1", "env_1"))).toBe(2);
      const deliveries = await repo.convex.claimDueDeliveries(
        "2099-01-01T00:00:00.000Z",
        "lease_1",
        "2099-01-01T00:01:00.000Z",
        10,
      );
      expect(deliveries).toHaveLength(1);
      expect(JSON.parse(deliveries[0]?.bodyJson ?? "{}")).toMatchObject({
        type: "config.changed",
        appId: "app_1",
        environmentId: "env_1",
        environmentVersion: 2,
      });

      await local.d1
        .prepare(
          "INSERT INTO variants (id, flag_id, name, value, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("variant_1", "flag_1", "on", "true", now)
        .run();

      expect(await repo.convex.environmentVersion(envScope("app_1", "env_1"))).toBe(3);
      const variantDeliveries = await repo.convex.claimDueDeliveries(
        "2099-01-01T00:00:02.000Z",
        "lease_2",
        "2099-01-01T00:01:00.000Z",
        10,
      );
      expect(variantDeliveries).toHaveLength(1);
      expect(JSON.parse(variantDeliveries[0]?.bodyJson ?? "{}")).toMatchObject({
        environmentVersion: 3,
      });

      const scope = envScope("app_1", "env_1");
      await repo.experiments.experiments.insert(scope, {
        id: "experiment_1",
        appId: "app_1",
        environmentId: "env_1",
        key: "checkout-test",
        flagId: "flag_1",
        name: "Checkout test",
        targetingKeyField: "userId",
        targetingKeyType: "user",
        metrics: "[]",
        guardrailMetrics: "[]",
        dimensions: "[]",
        createdAt: now,
        updatedAt: now,
      });
      await repo.experiments.runs.insert(scope, {
        id: "run_1",
        appId: "app_1",
        environmentId: "env_1",
        experimentId: "experiment_1",
        runNumber: 1,
        status: "ended",
        targetingKeyField: "userId",
        targetingKeyType: "user",
        salt: "run-salt",
        allocation: '{"on":100}',
        variantSet: '[{"id":"variant_1","name":"on","value":true}]',
        controlVariantId: "variant_1",
        targetingRules: "[]",
        confidenceLevel: 0.95,
        decisionFamily: "[]",
        guardrailDecisions: "[]",
        configHash: "sha256:run-1",
        startedAt: "2026-08-25T11:00:00.000Z",
        endedAt: "2026-08-25T12:30:00.000Z",
        createdAt: now,
      });

      const installationReads = vi.spyOn(repo.convex, "listInstallationsByIds");
      const experimentReads = vi.spyOn(repo.experiments, "listExperimentsByIds");
      const flagReads = vi.spyOn(repo.flags, "listFlagsByIds");
      const runReads = vi.spyOn(repo.experiments, "listRunsByIds");
      await expect(
        loadConvexExposureVerificationConfigs(repo, {
          appId: "app_1",
          environmentId: "env_1",
          items: [
            {
              installationId: "00000000-0000-4000-8000-000000000001",
              flagKey: "checkout",
              experimentId: "experiment_1",
              runId: "run_1",
            },
            {
              installationId: "00000000-0000-4000-8000-000000000099",
              flagKey: "checkout",
              experimentId: "experiment_1",
              runId: "run_1",
            },
            {
              installationId: "00000000-0000-4000-8000-000000000001",
              flagKey: "wrong-key",
              experimentId: "experiment_1",
              runId: "run_1",
            },
            {
              installationId: "00000000-0000-4000-8000-000000000001",
              flagKey: "checkout",
              experimentId: "experiment_1",
              runId: "run_1",
            },
          ],
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          status: "found",
          config: expect.objectContaining({
            runId: "run_1",
            runConfigHash: "sha256:run-1",
            endedAt: "2026-08-25T12:30:00.000Z",
          }),
        }),
        { status: "installation_not_found" },
        { status: "configuration_not_found" },
        expect.objectContaining({
          status: "found",
          config: expect.objectContaining({ runId: "run_1" }),
        }),
      ]);
      expect(installationReads).toHaveBeenCalledTimes(1);
      expect(experimentReads).toHaveBeenCalledTimes(1);
      expect(flagReads).toHaveBeenCalledTimes(1);
      expect(runReads).toHaveBeenCalledTimes(1);

      await expect(
        loadConvexExposureVerificationConfig(repo, {
          appId: "app_1",
          environmentId: "env_1",
          installationId: "00000000-0000-4000-8000-000000000001",
          flagKey: "checkout",
          experimentId: "experiment_1",
          runId: "run_1",
        }),
      ).resolves.toMatchObject({
        status: "found",
        config: { runId: "run_1", runConfigHash: "sha256:run-1" },
      });

      await local.d1
        .prepare("UPDATE experiments SET status = 'archived' WHERE id = ?")
        .bind("experiment_1")
        .run();
      await expect(
        loadConvexExposureVerificationConfigs(repo, {
          appId: "app_1",
          environmentId: "env_1",
          items: [
            {
              installationId: "00000000-0000-4000-8000-000000000001",
              flagKey: "checkout",
              experimentId: "experiment_1",
              runId: "run_1",
            },
          ],
        }),
      ).resolves.toEqual([{ status: "configuration_not_found" }]);
    } finally {
      await local.dispose();
    }
  });
});
