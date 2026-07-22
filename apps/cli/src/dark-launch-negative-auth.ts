import { expect } from "vitest";
import { appToken } from "../../control-plane-api/src/flag-definition-test-harness.js";
import {
  controlPlaneDelete,
  controlPlaneGet,
  controlPlanePost,
  type PackedSdk,
} from "./dark-launch-http.js";
import { quickstartOrigins, type QuickstartHarness } from "./quickstart-local-harness.js";

const FLAG_KEY = "dark-launch-demo";
const COHORT_ATTRIBUTE = "cohort";
const COHORT_VALUE = "launch";
const TARGETED_KEY = "dark-launch-user-targeted";

export async function proveLocalNegativeAuth(
  harness: QuickstartHarness,
  packedSdk: PackedSdk,
  flagId: string,
): Promise<void> {
  const probeApps: string[] = [];

  try {
    const wrongApp = await createProbeApp(harness, `wrong-app-${Date.now()}`);
    probeApps.push(wrongApp.app.id);
    const wrongDev = wrongApp.environments.find((environment) => environment.key === "dev");
    expect(wrongDev).toBeDefined();
    const wrongKeyMaterial = wrongApp.clientKeys.find(
      (key) => key.environmentId === wrongDev?.id,
    )?.keyMaterial;
    expect(wrongKeyMaterial).toBeDefined();
    await expectAuthError(packedSdk, harness, wrongKeyMaterial ?? "", "FLAG_NOT_FOUND");

    const revokedProbe = await createProbeApp(harness, `revoked-app-${Date.now()}`);
    probeApps.push(revokedProbe.app.id);
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

    const crossKey = `should-fail-${Date.now()}`;
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
          key: crossKey,
        }),
      },
    );
    expect(crossOrg.ok).toBe(false);
    const crossBody = (await crossOrg.json()) as { code?: string };
    expect(["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"]).toContain(crossBody.code);

    const orgApps = await controlPlaneGet<{ items: { key: string }[] }>(
      harness,
      `/orgs/${harness.orgId}/apps`,
      harness.orgAccessToken,
    );
    expect(orgApps.items.some((item) => item.key === crossKey)).toBe(false);
  } finally {
    for (const appId of probeApps) {
      const token = await appToken(harness.flagHarness, appId);
      await controlPlaneDelete(harness, `/apps/${appId}`, token);
    }
  }

  await controlPlaneDelete(harness, `/apps/${harness.appId}/flags/${flagId}`);
  const flags = await controlPlaneGet<{ items: { key: string }[] }>(
    harness,
    `/apps/${harness.appId}/flags`,
  );
  expect(flags.items.some((item) => item.key === FLAG_KEY)).toBe(false);

  for (const appId of probeApps) {
    const response = await harness.routingFetch(
      `${quickstartOrigins.controlPlaneBaseUrl}/apps/${appId}`,
      { headers: { authorization: `Bearer ${harness.accessToken}` } },
    );
    expect(response.ok).toBe(false);
  }
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
