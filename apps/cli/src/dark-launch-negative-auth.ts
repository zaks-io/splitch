import { expect } from "vitest";
import { appToken } from "../../control-plane-api/src/flag-definition-test-harness.js";
import {
  controlPlaneDelete,
  controlPlaneGet,
  controlPlanePost,
  deleteFlagThroughApproval,
  type PackedSdk,
} from "./dark-launch-http.js";
import { quickstartOrigins, type QuickstartHarness } from "./quickstart-local-harness.js";

const FLAG_KEY = "dark-launch-demo";
const COHORT_ATTRIBUTE = "cohort";
const COHORT_VALUE = "launch";
const TARGETED_KEY = "dark-launch-user-targeted";
const WRONG_APP_VARIANT = "wrong-app-only";

export async function proveLocalNegativeAuth(
  harness: QuickstartHarness,
  packedSdk: PackedSdk,
  flagId: string,
): Promise<void> {
  const probeApps: Array<{ id: string; flagId?: string }> = [];

  try {
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
    const wrongFlagId = await createSameKeyWrongAppFlag(
      harness,
      wrongApp.app.id,
      wrongDev?.id ?? "",
      wrongToken,
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
          orgId: harness.foreignOrgId,
          organizationId: harness.foreignOrgId,
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
    const response = await harness.routingFetch(
      `${quickstartOrigins.controlPlaneBaseUrl}/apps/${probe.id}`,
      { headers: { authorization: `Bearer ${harness.accessToken}` } },
    );
    expect(response.ok).toBe(false);
  }
}

async function createSameKeyWrongAppFlag(
  harness: QuickstartHarness,
  appId: string,
  environmentId: string,
  token: string,
): Promise<string> {
  const createKey = `wrong-app-flag-${crypto.randomUUID()}`;
  const flag = await controlPlanePost<{
    id: string;
    variants: Array<{ id: string; name: string }>;
  }>(
    harness,
    `/apps/${appId}/flags`,
    {
      appId,
      key: FLAG_KEY,
      name: "Wrong App same-key proof",
      schema: { type: "string" },
      variants: [
        {
          name: WRONG_APP_VARIANT,
          value: WRONG_APP_VARIANT,
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
        availableVariantNames: [WRONG_APP_VARIANT, "journey-decoy"],
        idempotency_key: configKey,
      }),
    },
  );
  expect(config.ok).toBe(true);
  harness.invalidateFlagCache(appId);
  return flag.id;
}

async function createProbeApp(harness: QuickstartHarness, key: string) {
  return controlPlanePost<{
    app: { id: string };
    environments: { id: string; key: string }[];
    clientKeys: { environmentId: string; keyMaterial: string }[];
  }>(
    harness,
    `/orgs/${harness.orgId}/apps`,
    { organizationId: harness.orgId, name: `Probe ${key}`, key },
    harness.orgAccessToken,
  );
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
