import { envScope } from "@splitch/db";
import { expect } from "vitest";
import { runCli } from "./cli.js";
import type { PackedSdk } from "./dark-launch-http.js";
import { EXIT_OK } from "./exit-codes.js";
import type { QuickstartHarness } from "./quickstart-local-harness.js";

const FLAG_KEY = "dark-launch-demo";
const EXPERIMENT_KEY = "dark-launch-experiment";
const TARGETED_KEY = "dark-launch-user-targeted";
const COHORT_ATTRIBUTE = "cohort";
const COHORT_VALUE = "launch";

export type DarkLaunchCliOptions = {
  credentialPath: string;
  fetch: typeof fetch;
  controlPlaneBaseUrl: string;
  evaluationBaseUrl: string;
};

type PackedClient = ReturnType<PackedSdk["createSplitchClient"]>;

export async function proveLocalExperimentExposure(
  harness: QuickstartHarness,
  cli: DarkLaunchCliOptions,
  client: PackedClient,
  flagId: string,
): Promise<void> {
  const experiment = await createAndStartExperiment(harness, cli, flagId);
  await proveEvaluateObservation(harness, client, experiment.id, experiment.runId);
  await endAndDeleteExperiment(harness, cli, experiment.id, experiment.runId);
}

async function createAndStartExperiment(
  harness: QuickstartHarness,
  cli: DarkLaunchCliOptions,
  flagId: string,
): Promise<{ id: string; runId: string }> {
  expect(
    await runCli(
      [
        "experiments",
        "create",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.devEnvironmentId,
        "--body-json",
        JSON.stringify({
          name: "Dark launch onboarding proof",
          key: EXPERIMENT_KEY,
          flagId,
          targetingKey: "targetingKey",
          targetingKeyType: "user",
          metrics: [],
          allocation: { on: 50, off: 50 },
          salt: "dark-launch-onboarding-proof",
        }),
      ],
      cli,
    ),
  ).toBe(EXIT_OK);

  const scope = envScope(harness.appId, harness.devEnvironmentId);
  const experiment = (await harness.repo.experiments.listExperiments(scope)).find(
    (candidate) => candidate.key === EXPERIMENT_KEY,
  );
  expect(experiment).toBeDefined();

  expect(
    await runCli(
      [
        "experiments",
        "start",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.devEnvironmentId,
        experiment?.id ?? "missing",
        "--idempotency-key",
        "dark-launch-start-1",
      ],
      cli,
    ),
  ).toBe(EXIT_OK);
  harness.invalidateFlagCache();

  const runs = await harness.repo.experiments.listRunsForExperiment(
    scope,
    experiment?.id ?? "missing",
  );
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ status: "running" });
  return { id: experiment?.id ?? "missing", runId: runs[0]?.id ?? "missing" };
}

async function proveEvaluateObservation(
  harness: QuickstartHarness,
  client: PackedClient,
  experimentId: string,
  runId: string,
): Promise<void> {
  expect(harness.evaluationCommitSink.writes).toEqual([]);
  expect(harness.exposureSink.writes).toEqual([]);

  const verified = await client.verify(FLAG_KEY, {
    targetingKey: TARGETED_KEY,
    attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
  });
  expect(verified.reason).not.toBe("ERROR");
  expect(harness.exposureSink.writes).toEqual([]);

  const idempotencyKey = "dark-launch-eval-local-1";
  const first = await client.evaluateDetails(FLAG_KEY, {
    targetingKey: TARGETED_KEY,
    attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    idempotencyKey,
  });
  expect(first).toMatchObject({ value: true });
  expect(first.reason).not.toBe("ERROR");

  const retry = await client.evaluateDetails(FLAG_KEY, {
    targetingKey: TARGETED_KEY,
    attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    idempotencyKey,
  });
  expect(retry.value).toBe(true);

  expect(harness.exposureSink.writes).toHaveLength(1);
  expect(harness.exposureSink.writes[0]).toMatchObject({
    experimentId,
    runId,
    appId: harness.appId,
    environmentId: harness.devEnvironmentId,
  });
  expect(harness.exposureSink.writes[0]?.variantName).not.toBe("__multiple__");
  const exposureJson = JSON.stringify(harness.exposureSink.writes[0]);
  expect(exposureJson).not.toContain(TARGETED_KEY);
  expect(exposureJson).not.toContain("quickstart-salt");
  const commits = harness.evaluationCommitSink.writes.filter(
    (write) => write.usage.idempotencyKey === idempotencyKey,
  );
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({ usage: { flagKey: FLAG_KEY, hasExposure: true } });
}

async function endAndDeleteExperiment(
  harness: QuickstartHarness,
  cli: DarkLaunchCliOptions,
  experimentId: string,
  runId: string,
): Promise<void> {
  expect(
    await runCli(
      ["runs", "end", "--json", "--app", harness.appId, "--env", harness.devEnvironmentId, runId],
      cli,
    ),
  ).toBe(EXIT_OK);
  expect(
    await runCli(
      [
        "experiments",
        "delete",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.devEnvironmentId,
        experimentId,
      ],
      cli,
    ),
  ).toBe(EXIT_OK);
  harness.invalidateFlagCache();
}
