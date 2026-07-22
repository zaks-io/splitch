/** Negative proofs and cleanup for the dark-launch journey. */

import { COHORT_ATTRIBUTE, COHORT_VALUE } from "./constants.mjs";
import {
  clientKeyMaterialFromCreate,
  controlPlaneCall,
  createDarkLaunchApp,
  deleteApp,
  deleteFlag,
  listApps,
  listFlags,
  rotateClientKey,
} from "./control-plane.mjs";

export async function runNegativeProofs(deps, resources, keys, resolve) {
  const wrongKeys = {
    ...keys,
    appKey: `${keys.appKey}-wrong`,
    appName: `${keys.appName} Wrong`,
  };
  const wrongApp = await createDarkLaunchApp(deps, wrongKeys);
  resources.transientAppKeys.push(wrongKeys.appKey);
  const wrongDev = wrongApp.environments.find((environment) => environment.key === "dev");
  if (!wrongDev) throw new Error("wrong-App create missing dev Environment");
  const wrongKeyMaterial = clientKeyMaterialFromCreate(wrongApp, wrongDev.id);

  await assertLoudFailure(
    () =>
      resolve("verify", {
        clientKey: wrongKeyMaterial,
        targetingKey: keys.targetedKey,
        attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
      }),
    "wrong-App credentials did not fail loudly",
  );

  const priorKey = resources.clientKeyMaterial;
  const rotated = await rotateClientKey(deps, resources.appId, resources.environmentId);
  resources.clientKeyMaterial = rotated.newKey?.keyMaterial ?? rotated.keyMaterial;
  if (!resources.clientKeyMaterial) {
    throw new Error("client_key_rotate did not return replacement keyMaterial");
  }
  await assertLoudFailure(
    () =>
      resolve("verify", {
        clientKey: priorKey,
        targetingKey: keys.targetedKey,
        attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
      }),
    "revoked credential did not fail loudly",
  );

  const crossOrg = await controlPlaneCall(deps, "POST", `/orgs/org_not_a_member/apps`, {
    orgId: "org_not_a_member",
    organizationId: "org_not_a_member",
    name: "Should Fail",
    key: `${keys.appKey}-cross-org`,
    description: "Unauthorized cross-Organization mutation probe.",
    idempotency_key: `${keys.appKey}-cross-org`,
  });
  if (crossOrg.ok) throw new Error("cross-Organization mutation unexpectedly succeeded");
  if (![401, 403, 404].includes(crossOrg.status)) {
    throw new Error(
      `cross-Organization mutation expected auth failure, got HTTP ${crossOrg.status}`,
    );
  }

  if (deps.deleteApp) {
    await deps.deleteApp(wrongApp.app.id);
  } else {
    try {
      await deleteApp(deps, wrongApp.app.id);
    } catch {
      // Shared-preview smoke token is co-scoped to the seeded App.
    }
  }
}

async function assertLoudFailure(action, message) {
  try {
    const details = await action();
    if (details.reason !== "ERROR") throw new Error(message);
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error;
  }
}

export async function cleanupDarkLaunch(deps, resources, keys) {
  if (resources.appId && resources.flagId) {
    try {
      await deleteFlag(deps, resources.appId, resources.flagId);
    } catch {
      // Flag may already be gone.
    }
  }
  if (resources.ownsApp && resources.appId) {
    try {
      await deleteApp(deps, resources.appId);
    } catch {
      // App may already be gone.
    }
  }

  if (deps.assertCleanup) {
    await deps.assertCleanup({ resources, keys });
    return;
  }

  if (deps.orgId && resources.appId) {
    const flags = await listFlags(deps, resources.appId);
    const flagItems = Array.isArray(flags) ? flags : (flags.items ?? []);
    const orphanFlag = flagItems.find((flag) => flag.key === keys.flagKey);
    if (orphanFlag) {
      throw new Error(`cleanup left orphaned Flag ${orphanFlag.id} (${orphanFlag.key})`);
    }
  }

  if (deps.orgId) {
    const apps = await listApps(deps, deps.orgId);
    const items = Array.isArray(apps) ? apps : (apps.items ?? apps.apps ?? []);
    const watchedKeys = new Set([
      keys.appKey,
      `${keys.appKey}-wrong`,
      ...resources.transientAppKeys,
    ]);
    const orphanApp = items.find((app) => watchedKeys.has(app.key));
    if (orphanApp) {
      throw new Error(`cleanup left orphaned App ${orphanApp.id} (${orphanApp.key})`);
    }
  }
}
