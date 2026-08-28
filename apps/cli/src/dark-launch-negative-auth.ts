import { expect } from "vitest";
import { appToken } from "../../control-plane-api/src/flag-definition-test-harness.js";
import {
  controlPlaneDelete,
  controlPlaneGet,
  controlPlanePost,
  deleteFlagThroughApproval,
  type PackedSdk,
} from "./dark-launch-http.js";
import { type QuickstartHarness, quickstartOrigins } from "./quickstart-local-harness.js";

const FLAG_KEY = "dark-launch-demo";
const COHORT_ATTRIBUTE = "cohort";
const COHORT_VALUE = "launch";
const TARGETED_KEY = "dark-launch-user-targeted";
const WRONG_APP_VARIANT = "wrong-app-only";
const JOURNEY_ONLY_FLAG_KEY = "dark-launch-journey-only";
const JOURNEY_ONLY_VARIANT = "journey-app-only";

export async function proveLocalNegativeAuth(
  harness: QuickstartHarness,
  packedSdk: PackedSdk,
  flagId: string,
): Promise<void> {
  const probeApps: Array<{ id: string; flagId?: string }> = [];
  let journeyOnlyFlagId: string | undefined;

  try {
    journeyOnlyFlagId = await createJourneyOnlyFlag(harness);
    await assertJourneyOnlyFlagResolution(harness, packedSdk);

    const wrongApp = await createProbeApp(harness, `wrong-app-${Date.now()}`);
    const wrongProbe: { id: string; flagId?: string } = { id: wrongApp.app.id };
    probeApps.push(wrongProbe);
    const wrongDev = wrongApp.environments.find((environment) => environment.key === "dev");
    expect(wrongDev).toBeDefined();
    const wrongKeyMaterial = wrongApp.clientKeys.find(
      (key) => key.environmentId === wrongDev?.id,
    )?.keyMaterial;
    expect(wrongKeyMaterial).toBeDefined();
    const wrongToken = await appToken(harness.flagHarness, wrongApp.app.id);
    const wrongFlagId = await createProbeFlag(
      harness,
      wrongApp.app.id,
      wrongDev?.id ?? "",
      wrongToken,
      FLAG_KEY,
      WRONG_APP_VARIANT,
    );
    wrongProbe.flagId = wrongFlagId;
    const wrongResolution = await packedSdk
      .createSplitchClient({
        clientKey: wrongKeyMaterial ?? "",
        endpoint: quickstartOrigins.evaluationBaseUrl,
        fetch: harness.routingFetch,
      })
      .verify(FLAG_KEY, {
        targetingKey: TARGETED_KEY,
        attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
      });
    expect(wrongResolution.reason).not.toBe("ERROR");
    expect(wrongResolution.value).toBe(WRONG_APP_VARIANT);
    expect(wrongResolution.variantName).toBe(WRONG_APP_VARIANT);
    expect(wrongResolution.variantName).not.toBe("on");

    const scopedMiss = await packedSdk
      .createSplitchClient({
        clientKey: wrongKeyMaterial ?? "",
        endpoint: quickstartOrigins.evaluationBaseUrl,
        fetch: harness.routingFetch,
      })
      .verify(JOURNEY_ONLY_FLAG_KEY, {
        targetingKey: TARGETED_KEY,
        attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
      });
    expect(scopedMiss.reason).toBe("ERROR");
    expect(scopedMiss.errorCode).toBe("FLAG_NOT_FOUND");

    const revokedProbe = await createProbeApp(harness, `revoked-app-${Date.now()}`);
    probeApps.push({ id: revokedProbe.app.id });
    const revokedDev = revokedProbe.environments.find((environment) => environment.key === "dev");
    expect(revokedDev).toBeDefined();
    const priorKey = revokedProbe.clientKeys.find(
      (key) => key.environmentId === revokedDev?.id,
    )?.keyMaterial;
    expect(priorKey).toBeDefined();

    const probeToken = await appToken(harness.flagHarness, revokedProbe.app.id);
    const rotated = await controlPlanePost<{ newKey: { keyMaterial: string } }>(
      harness,
      `/apps/${revokedProbe.app.id}/envs/${revokedDev?.id}/client-key/revoke`,
      {},
      probeToken,
    );
    expect(rotated.newKey.keyMaterial).not.toBe(priorKey);
    await expectAuthError(packedSdk, harness, priorKey ?? "", "CREDENTIAL_REVOKED");

    const foreignOrg = await harness.repo.identity.getOrg(harness.foreignOrgId);
    expect(foreignOrg?.id).toBe(harness.foreignOrgId);
    const crossKey = `should-fail-${Date.now()}`;
    const crossOrg = await harness.routingFetch(
      `${quickstartOrigins.controlPlaneBaseUrl}/orgs/${harness.foreignOrgId}/apps`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.foreignOrgAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Should Fail",
          key: crossKey,
        }),
      },
    );
    expect(crossOrg.ok).toBe(false);
    const crossBody = (await crossOrg.json()) as { code?: string };
    expect(crossBody.code).toBe("FORBIDDEN");

    const foreignList = await harness.routingFetch(
      `${quickstartOrigins.controlPlaneBaseUrl}/orgs/${harness.foreignOrgId}/apps`,
      { headers: { authorization: `Bearer ${harness.foreignOrgAccessToken}` } },
    );
    expect(foreignList.ok).toBe(false);
    const foreignListBody = (await foreignList.json()) as { code?: string };
    expect(foreignListBody.code).toBe("FORBIDDEN");

    const orgApps = await controlPlaneGet<{ items: { key: string }[] }>(
      harness,
      `/orgs/${harness.orgId}/apps`,
      harness.orgAccessToken,
    );
    expect(orgApps.items.some((item) => item.key === crossKey)).toBe(false);
  } finally {
    if (journeyOnlyFlagId) {
      await deleteFlagThroughApproval(harness, harness.appId, journeyOnlyFlagId);
    }
    for (const probe of probeApps) {
      const token = await appToken(harness.flagHarness, probe.id);
      if (probe.flagId) {
        await deleteFlagThroughApproval(harness, probe.id, probe.flagId, token);
      }
      const deleted = await controlPlaneDelete(harness, `/apps/${probe.id}`, token);
      expect(deleted.ok).toBe(true);
    }
  }

  await deleteFlagThroughApproval(harness, harness.appId, flagId);
  const flags = await controlPlaneGet<{ items: { key: string }[] }>(
    harness,
    `/apps/${harness.appId}/flags`,
  );
  expect(flags.items.some((item) => item.key === FLAG_KEY)).toBe(false);

  for (const probe of probeApps) {
    const token = await appToken(harness.flagHarness, probe.id);
    const response = await harness.routingFetch(
      `${quickstartOrigins.controlPlaneBaseUrl}/apps/${probe.id}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(404);
  }
}

async function createJourneyOnlyFlag(harness: QuickstartHarness): Promise<string> {
  const flagId = await createProbeFlag(
    harness,
    harness.appId,
    harness.devEnvironmentId,
    harness.accessToken,
    JOURNEY_ONLY_FLAG_KEY,
    JOURNEY_ONLY_VARIANT,
  );
  harness.invalidateFlagCache();
  return flagId;
}

async function assertJourneyOnlyFlagResolution(
  harness: QuickstartHarness,
  packedSdk: PackedSdk,
): Promise<void> {
  const journeyKey = await controlPlaneGet<{ keyMaterial: string }>(
    harness,
    `/apps/${harness.appId}/envs/${harness.devEnvironmentId}/client-key`,
  );
  const resolution = await packedSdk
    .createSplitchClient({
      clientKey: journeyKey.keyMaterial,
      endpoint: quickstartOrigins.evaluationBaseUrl,
      fetch: harness.routingFetch,
    })
    .verify(JOURNEY_ONLY_FLAG_KEY, {
      targetingKey: TARGETED_KEY,
      attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    });
  expect(resolution.reason).not.toBe("ERROR");
  expect(resolution.variantName).toBe(JOURNEY_ONLY_VARIANT);
}

async function createProbeFlag(
  harness: QuickstartHarness,
  appId: string,
  environmentId: string,
  token: string,
  flagKey: string,
  variantName: string,
): Promise<string> {
  const createKey = `isolation-flag-${crypto.randomUUID()}`;
  const flag = await controlPlanePost<{
    id: string;
    variants: Array<{ id: string; name: string }>;
  }>(
    harness,
    `/apps/${appId}/flags`,
    {
      appId,
      key: flagKey,
      name: `${flagKey} isolation proof`,
      schema: { type: "string" },
      variants: [
        {
          name: variantName,
          value: variantName,
          isDefault: true,
        },
        { name: "journey-decoy", value: "journey-decoy", isDefault: false },
      ],
      idempotency_key: createKey,
    },
    token,
  );
  const configKey = `wrong-app-config-${crypto.randomUUID()}`;
  const config = await harness.routingFetch(
    `${quickstartOrigins.controlPlaneBaseUrl}/apps/${appId}/envs/${environmentId}/flags/${flag.id}/config`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": configKey,
      },
      body: JSON.stringify({
        enabled: true,
        availableVariantNames: [variantName, "journey-decoy"],
        idempotency_key: configKey,
      }),
    },
  );
  expect(config.ok).toBe(true);
  harness.invalidateFlagCache(appId, [environmentId]);
  return flag.id;
}

async function createProbeApp(harness: QuickstartHarness, key: string) {
  return controlPlanePost<{
    app: { id: string };
    environments: { id: string; key: string }[];
    clientKeys: { environmentId: string; keyMaterial: string }[];
  }>(harness, `/orgs/${harness.orgId}/apps`, { name: `Probe ${key}`, key }, harness.orgAccessToken);
}

async function expectAuthError(
  packedSdk: PackedSdk,
  harness: QuickstartHarness,
  clientKey: string,
  errorCode: string,
): Promise<void> {
  const details = await packedSdk
    .createSplitchClient({
      clientKey,
      endpoint: quickstartOrigins.evaluationBaseUrl,
      fetch: harness.routingFetch,
    })
    .verify(FLAG_KEY, {
      targetingKey: TARGETED_KEY,
      attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    });
  expect(details.reason).toBe("ERROR");
  expect(details.errorCode).toBe(errorCode);
}
