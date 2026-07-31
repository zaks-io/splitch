import { writeFile } from "node:fs/promises";
import { expect } from "vitest";
import { runCli } from "./cli.js";
import {
  type DarkLaunchCliOptions,
  proveLocalExperimentExposure,
} from "./dark-launch-experiment.js";
import { controlPlaneGet, expectVariant, type PackedSdk, variantId } from "./dark-launch-http.js";
import { proveLocalNegativeAuth } from "./dark-launch-negative-auth.js";
import { EXIT_OK } from "./exit-codes.js";
import {
  findFlagByKey,
  type QuickstartHarness,
  quickstartOrigins,
  storedHarnessCredential,
} from "./quickstart-local-harness.js";
import { makeTempHome } from "./test-helpers.js";

const FLAG_KEY = "dark-launch-demo";
const COHORT_ATTRIBUTE = "cohort";
const COHORT_VALUE = "launch";
const TARGETED_KEY = "dark-launch-user-targeted";
const UNTARGETED_KEY = "dark-launch-user-untargeted";
type PackedClient = ReturnType<PackedSdk["createSplitchClient"]>;

export async function runLocalDarkLaunchScenario(
  harness: QuickstartHarness,
  packedSdk: PackedSdk,
): Promise<void> {
  const cli = await openCli(harness);
  const flag = await createFlag(harness, cli);
  const clientKey = await controlPlaneGet<{ keyMaterial: string }>(
    harness,
    `/apps/${harness.appId}/envs/${harness.devEnvironmentId}/client-key`,
  );
  const activeKeyMaterial = clientKey.keyMaterial;
  const client = packedSdk.createSplitchClient({
    clientKey: activeKeyMaterial,
    endpoint: quickstartOrigins.evaluationBaseUrl,
    fetch: harness.routingFetch,
    // Synthetic journey evidence is intentionally quiet: the SDK's structured
    // ResolutionDetails remain the fail-loud assertion surface without printing
    // credential material or unnecessary raw identifiers.
    logger: { error() {}, debug() {} },
  });

  await expectVariant(client, TARGETED_KEY, { [COHORT_ATTRIBUTE]: COHORT_VALUE }, "off");
  await expectVariant(client, UNTARGETED_KEY, { [COHORT_ATTRIBUTE]: "other" }, "off");

  await enableTargetedRule(harness, cli, flag.id);
  await expectVariant(client, TARGETED_KEY, { [COHORT_ATTRIBUTE]: COHORT_VALUE }, "on");
  await expectVariant(client, UNTARGETED_KEY, { [COHORT_ATTRIBUTE]: "other" }, "off");

  await proveLocalExperimentExposure(harness, cli, client, flag.id);
  await killSwitchOff(harness, cli, flag.id, client);
  await proveLocalNegativeAuth(harness, packedSdk, flag.id);

  const activeAfter = await controlPlaneGet<{ keyMaterial: string; revokedAt?: string | null }>(
    harness,
    `/apps/${harness.appId}/envs/${harness.devEnvironmentId}/client-key`,
  );
  expect(activeAfter.keyMaterial).toBe(activeKeyMaterial);
  expect(activeAfter.revokedAt ?? null).toBeNull();
}

async function openCli(harness: QuickstartHarness): Promise<DarkLaunchCliOptions> {
  const { credentialPath } = await makeTempHome();
  await writeFile(credentialPath, `${JSON.stringify(storedHarnessCredential(harness))}\n`);
  return {
    credentialPath,
    fetch: harness.routingFetch,
    controlPlaneBaseUrl: quickstartOrigins.controlPlaneBaseUrl,
    evaluationBaseUrl: quickstartOrigins.evaluationBaseUrl,
  };
}

async function createFlag(harness: QuickstartHarness, cli: DarkLaunchCliOptions) {
  expect(
    await runCli(
      [
        "flags",
        "create",
        "--json",
        "--app",
        harness.appId,
        "--key",
        FLAG_KEY,
        "--variants",
        "on,off",
      ],
      cli,
    ),
  ).toBe(EXIT_OK);
  const flag = await findFlagByKey(harness, FLAG_KEY);
  expect(flag.variants.map((variant) => variant.name).sort()).toEqual(["off", "on"]);
  return flag;
}

async function enableTargetedRule(
  harness: QuickstartHarness,
  cli: DarkLaunchCliOptions,
  flagId: string,
): Promise<void> {
  expect(
    await runCli(
      [
        "flag-config",
        "update",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.devEnvironmentId,
        flagId,
        "--enabled",
        "true",
        "--body-json",
        JSON.stringify({ availableVariantNames: ["on", "off"] }),
      ],
      cli,
    ),
  ).toBe(EXIT_OK);

  const onVariantId = await variantId(harness, flagId, "on");
  expect(
    await runCli(
      [
        "flag-targeting-rules",
        "replace",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.devEnvironmentId,
        flagId,
        "--body-json",
        JSON.stringify({
          targetingRules: [
            {
              id: "rule-dark-launch",
              flagId,
              priority: 0,
              conditions: [{ attribute: COHORT_ATTRIBUTE, operator: "eq", value: COHORT_VALUE }],
              variantId: onVariantId,
              percentageRollout: null,
            },
          ],
        }),
      ],
      cli,
    ),
  ).toBe(EXIT_OK);
  harness.invalidateFlagCache();
}

async function killSwitchOff(
  harness: QuickstartHarness,
  cli: DarkLaunchCliOptions,
  flagId: string,
  client: PackedClient,
): Promise<void> {
  expect(
    await runCli(
      [
        "flag-config",
        "update",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.devEnvironmentId,
        flagId,
        "--enabled",
        "false",
      ],
      cli,
    ),
  ).toBe(EXIT_OK);
  harness.invalidateFlagCache();
  await expectVariant(client, TARGETED_KEY, { [COHORT_ATTRIBUTE]: COHORT_VALUE }, "off");
  await expectVariant(client, UNTARGETED_KEY, { [COHORT_ATTRIBUTE]: "other" }, "off");
}
