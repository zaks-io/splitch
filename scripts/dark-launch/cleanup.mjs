/** Negative proofs and cleanup for the dark-launch journey. */

import { COHORT_ATTRIBUTE, COHORT_VALUE } from "./constants.mjs";
import {
  clientKeyMaterialFromCreate,
  controlPlaneCall,
  createDarkLaunchApp,
  deleteApp,
  deleteExperiment,
  deleteFlag,
  endRun,
  getClientKey,
  listApps,
  listFlags,
  rotateClientKey,
} from "./control-plane.mjs";

/**
 * Negative authorization proofs.
 *
 * Hosted shared-preview: supply `wrongAppClientKey` and `revokedClientKey` from
 * stable seed fixtures (no rotation of the journey App, no orphan Apps).
 * Local / open org tokens: omit those fields to create fully deletable probe Apps.
 */
export async function runNegativeProofs(deps, resources, keys, resolve) {
  const probes = { appIds: [] };

  try {
    const wrongKeyMaterial = await resolveWrongAppClientKey(deps, resources, keys, probes);
    await assertStructuredAuthFailure(
      () =>
        resolve("verify", {
          clientKey: wrongKeyMaterial,
          targetingKey: keys.targetedKey,
          attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
        }),
      "FLAG_NOT_FOUND",
      "wrong-App credentials",
    );

    const revokedKeyMaterial = await resolveRevokedClientKey(deps, resources, keys, probes);
    await assertStructuredAuthFailure(
      () =>
        resolve("verify", {
          clientKey: revokedKeyMaterial,
          targetingKey: keys.targetedKey,
          attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
        }),
      "CREDENTIAL_REVOKED",
      "revoked credential",
    );

    await proveCrossOrganizationWriteRejected(deps, keys);
  } finally {
    for (const appId of probes.appIds) {
      await deleteApp(deps, appId);
    }
  }
}

async function resolveWrongAppClientKey(deps, resources, keys, probes) {
  if (typeof deps.wrongAppClientKey === "string" && deps.wrongAppClientKey.length > 0) {
    return deps.wrongAppClientKey;
  }

  const wrongKeys = {
    ...keys,
    appKey: `${keys.appKey}-wrong`,
    appName: `${keys.appName} Wrong`,
  };
  const wrongApp = await createDarkLaunchApp(deps, wrongKeys);
  probes.appIds.push(wrongApp.app.id);
  resources.transientAppKeys.push(wrongKeys.appKey);
  const wrongDev = wrongApp.environments.find((environment) => environment.key === "dev");
  if (!wrongDev) throw new Error("wrong-App create missing dev Environment");
  return clientKeyMaterialFromCreate(wrongApp, wrongDev.id);
}

async function resolveRevokedClientKey(deps, resources, keys, probes) {
  if (typeof deps.revokedClientKey === "string" && deps.revokedClientKey.length > 0) {
    return deps.revokedClientKey;
  }

  const probeKeys = {
    ...keys,
    appKey: `${keys.appKey}-revoked`,
    appName: `${keys.appName} Revoked`,
  };
  const probeApp = await createDarkLaunchApp(deps, probeKeys);
  probes.appIds.push(probeApp.app.id);
  resources.transientAppKeys.push(probeKeys.appKey);
  const probeDev = probeApp.environments.find((environment) => environment.key === "dev");
  if (!probeDev) throw new Error("revoked-probe App create missing dev Environment");
  const priorKey = clientKeyMaterialFromCreate(probeApp, probeDev.id);
  await rotateClientKey(deps, probeApp.app.id, probeDev.id);
  return priorKey;
}

async function proveCrossOrganizationWriteRejected(deps, keys) {
  const crossKey = `${keys.appKey}-cross-org`;
  const body = {
    orgId: "org_not_a_member",
    organizationId: "org_not_a_member",
    name: "Should Fail",
    key: crossKey,
    description: "Unauthorized cross-Organization mutation probe.",
    idempotency_key: crossKey,
  };
  const crossOrg = deps.callToolResult
    ? await deps.callToolResult("apps_create", body)
    : await controlPlaneCall(deps, "POST", `/orgs/org_not_a_member/apps`, body);
  if (crossOrg.ok) {
    throw new Error("cross-Organization mutation unexpectedly succeeded");
  }
  const code = crossOrg.body && typeof crossOrg.body === "object" ? crossOrg.body.code : undefined;
  if (typeof code !== "string" || !["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"].includes(code)) {
    throw new Error(
      `cross-Organization mutation expected structured auth error, got HTTP ${crossOrg.status} body=${JSON.stringify(crossOrg.body)}`,
    );
  }

  if (deps.orgId) {
    const apps = await listApps(deps, deps.orgId);
    const items = Array.isArray(apps) ? apps : (apps.items ?? apps.apps ?? []);
    if (items.some((app) => app.key === crossKey)) {
      throw new Error(`cross-Organization write leaked App key ${crossKey} into smoke Org`);
    }
  }

  const followUp = deps.callToolResult
    ? await deps.callToolResult("apps_list", { orgId: "org_not_a_member" })
    : await controlPlaneCall(deps, "GET", `/orgs/org_not_a_member/apps`);
  if (followUp.ok) {
    throw new Error("cross-Organization follow-up list unexpectedly succeeded");
  }
}

export async function assertStructuredAuthFailure(action, expectedErrorCode, label) {
  let details;
  try {
    details = await action();
  } catch (error) {
    throw new Error(
      `${label}: expected structured ResolutionDetails with errorCode ${expectedErrorCode}, but the call threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!details || typeof details !== "object") {
    throw new Error(`${label}: expected ResolutionDetails object, got ${JSON.stringify(details)}`);
  }
  if (details.reason !== "ERROR") {
    throw new Error(`${label}: expected reason ERROR, got ${JSON.stringify(details)}`);
  }
  if (details.errorCode !== expectedErrorCode) {
    throw new Error(
      `${label}: expected errorCode ${expectedErrorCode}, got ${JSON.stringify(details)}`,
    );
  }
}

export async function cleanupDarkLaunch(deps, resources, keys) {
  const activeKeyBefore = resources.clientKeyMaterial;

  if (resources.runId) {
    await endRun(deps, resources);
    resources.runId = null;
  }

  if (resources.experimentId) {
    await deleteExperiment(deps, resources);
    resources.experimentId = null;
  }

  if (resources.appId && resources.flagId) {
    await deleteFlag(deps, resources.appId, resources.flagId);
    resources.flagId = null;
  }

  if (resources.ownsApp && resources.appId) {
    await deleteApp(deps, resources.appId);
    resources.appId = null;
  }

  if (deps.assertCleanup) {
    await deps.assertCleanup({ resources, keys, activeKeyBefore });
    return;
  }

  await assertNoOrphans(deps, resources, keys, activeKeyBefore);
}

async function assertNoOrphans(deps, resources, keys, activeKeyBefore) {
  if (deps.orgId) {
    const apps = await listApps(deps, deps.orgId);
    const items = Array.isArray(apps) ? apps : (apps.items ?? apps.apps ?? []);
    const watchedKeys = new Set([
      keys.appKey,
      `${keys.appKey}-wrong`,
      `${keys.appKey}-revoked`,
      `${keys.appKey}-cross-org`,
      ...resources.transientAppKeys,
    ]);
    const orphanApp = items.find((app) => watchedKeys.has(app.key));
    if (orphanApp) {
      throw new Error(`cleanup left orphaned App ${orphanApp.id} (${orphanApp.key})`);
    }
  }

  if (resources.appId) {
    const flags = await listFlags(deps, resources.appId);
    const flagItems = Array.isArray(flags) ? flags : (flags.items ?? []);
    const orphanFlag = flagItems.find((flag) => flag.key === keys.flagKey);
    if (orphanFlag) {
      throw new Error(`cleanup left orphaned Flag ${orphanFlag.id} (${orphanFlag.key})`);
    }

    if (resources.environmentId && activeKeyBefore) {
      const activeKey = await getClientKey(deps, resources.appId, resources.environmentId);
      if (activeKey.keyMaterial !== activeKeyBefore) {
        throw new Error(
          `cleanup left rotated Client Key on journey App (expected stable material)`,
        );
      }
      if (activeKey.revokedAt) {
        throw new Error("journey App active Client Key is revoked after cleanup");
      }
    }
  }
}
