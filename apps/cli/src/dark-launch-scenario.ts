import { writeFile } from "node:fs/promises";
import { expect } from "vitest";
import { appToken } from "../../control-plane-api/src/flag-definition-test-harness.js";
import { runCli } from "./cli.js";
import {
  controlPlaneDelete,
  controlPlaneGet,
  controlPlanePost,
  expectVariant,
  type PackedSdk,
  variantId,
} from "./dark-launch-http.js";
import { EXIT_OK } from "./exit-codes.js";
import {
  findFlagByKey,
  quickstartOrigins,
  storedHarnessCredential,
  type QuickstartHarness,
} from "./quickstart-local-harness.js";
import { makeTempHome } from "./test-helpers.js";

const FLAG_KEY = "dark-launch-demo";
const COHORT_ATTRIBUTE = "cohort";
const COHORT_VALUE = "launch";
const TARGETED_KEY = "dark-launch-user-targeted";
const UNTARGETED_KEY = "dark-launch-user-untargeted";

type CliOptions = {
  credentialPath: string;
  fetch: typeof fetch;
  controlPlaneBaseUrl: string;
  evaluationBaseUrl: string;
};

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
  const client = packedSdk.createSplitchClient({
    clientKey: clientKey.keyMaterial,
    endpoint: quickstartOrigins.evaluationBaseUrl,
    fetch: harness.routingFetch,
  });

  await expectVariant(client, TARGETED_KEY, { [COHORT_ATTRIBUTE]: COHORT_VALUE }, "off");
  await expectVariant(client, UNTARGETED_KEY, { [COHORT_ATTRIBUTE]: "other" }, "off");

  await enableTargetedRule(harness, cli, flag.id);
  await expectVariant(client, TARGETED_KEY, { [COHORT_ATTRIBUTE]: COHORT_VALUE }, "on");
  await expectVariant(client, UNTARGETED_KEY, { [COHORT_ATTRIBUTE]: "other" }, "off");

  await proveEvaluateObservation(harness, client);
  await killSwitchOff(harness, cli, flag.id, client);
  await proveNegativeAuth(harness, packedSdk, clientKey.keyMaterial, flag.id);
}

async function openCli(harness: QuickstartHarness): Promise<CliOptions> {
  const { credentialPath } = await makeTempHome();
  await writeFile(credentialPath, `${JSON.stringify(storedHarnessCredential(harness))}\n`);
  return {
    credentialPath,
    fetch: harness.routingFetch,
    controlPlaneBaseUrl: quickstartOrigins.controlPlaneBaseUrl,
    evaluationBaseUrl: quickstartOrigins.evaluationBaseUrl,
  };
}

async function createFlag(harness: QuickstartHarness, cli: CliOptions) {
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
  cli: CliOptions,
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

async function proveEvaluateObservation(
  harness: QuickstartHarness,
  client: ReturnType<PackedSdk["createSplitchClient"]>,
): Promise<void> {
  expect(harness.evaluationCommitSink.writes.length).toBe(0);
  expect(harness.exposureSink.writes.length).toBe(0);

  const idempotencyKey = "dark-launch-eval-local-1";
  const first = await client.evaluateDetails(FLAG_KEY, {
    targetingKey: TARGETED_KEY,
    attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    idempotencyKey,
  });
  expect(first.value).toBe(true);
  expect(first.reason).not.toBe("ERROR");

  const retry = await client.evaluateDetails(FLAG_KEY, {
    targetingKey: TARGETED_KEY,
    attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    idempotencyKey,
  });
  expect(retry.value).toBe(true);

  expect(harness.evaluationCommitSink.writes.length).toBeGreaterThanOrEqual(1);
  expect(harness.evaluationCommitSink.writes[0]?.usage.idempotencyKey).toBe(idempotencyKey);
  expect(
    harness.evaluationCommitSink.writes.every((write) => write.usage.flagKey === FLAG_KEY),
  ).toBe(true);
  expect(harness.exposureSink.writes).toEqual([]);
}

async function killSwitchOff(
  harness: QuickstartHarness,
  cli: CliOptions,
  flagId: string,
  client: ReturnType<PackedSdk["createSplitchClient"]>,
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

async function proveNegativeAuth(
  harness: QuickstartHarness,
  packedSdk: PackedSdk,
  priorKeyMaterial: string,
  flagId: string,
): Promise<void> {
  const wrongApp = await controlPlanePost<{
    app: { id: string };
    environments: { id: string; key: string }[];
    clientKeys: { environmentId: string; keyMaterial: string }[];
  }>(
    harness,
    `/orgs/${harness.orgId}/apps`,
    { organizationId: harness.orgId, name: "Wrong App", key: `wrong-app-${Date.now()}` },
    harness.orgAccessToken,
  );
  const wrongDev = wrongApp.environments.find((environment) => environment.key === "dev");
  expect(wrongDev).toBeDefined();
  const wrongKeyMaterial = wrongApp.clientKeys.find(
    (key) => key.environmentId === wrongDev?.id,
  )?.keyMaterial;
  expect(wrongKeyMaterial).toBeDefined();

  const wrongDetails = await packedSdk
    .createSplitchClient({
      clientKey: wrongKeyMaterial ?? "",
      endpoint: quickstartOrigins.evaluationBaseUrl,
      fetch: harness.routingFetch,
    })
    .verify(FLAG_KEY, {
      targetingKey: TARGETED_KEY,
      attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    });
  expect(wrongDetails.reason).toBe("ERROR");

  const rotated = await controlPlanePost<{ newKey: { keyMaterial: string } }>(
    harness,
    `/apps/${harness.appId}/envs/${harness.devEnvironmentId}/client-key/revoke`,
    {},
  );
  expect(rotated.newKey.keyMaterial).not.toBe(priorKeyMaterial);
  const revokedDetails = await packedSdk
    .createSplitchClient({
      clientKey: priorKeyMaterial,
      endpoint: quickstartOrigins.evaluationBaseUrl,
      fetch: harness.routingFetch,
    })
    .verify(FLAG_KEY, {
      targetingKey: TARGETED_KEY,
      attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    });
  expect(revokedDetails.reason).toBe("ERROR");

  const crossOrg = await harness.routingFetch(
    `${quickstartOrigins.controlPlaneBaseUrl}/orgs/org_not_a_member/apps`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        orgId: "org_not_a_member",
        organizationId: "org_not_a_member",
        name: "Should Fail",
        key: "should-fail",
      }),
    },
  );
  expect(crossOrg.ok).toBe(false);
  expect([401, 403, 404]).toContain(crossOrg.status);

  const wrongAppToken = await appToken(harness.flagHarness, wrongApp.app.id);
  await controlPlaneDelete(harness, `/apps/${wrongApp.app.id}`, wrongAppToken);
  await controlPlaneDelete(harness, `/apps/${harness.appId}/flags/${flagId}`);
  const flags = await controlPlaneGet<{ items: { key: string }[] }>(
    harness,
    `/apps/${harness.appId}/flags`,
  );
  expect(flags.items.some((item) => item.key === FLAG_KEY)).toBe(false);
}
