/** Negative proofs and cleanup for the dark-launch journey. */

import {
  assertVariant,
  COHORT_ATTRIBUTE,
  COHORT_VALUE,
  PROPAGATION_WINDOW_MS,
} from "./constants.mjs";
import {
  clientKeyMaterialFromCreate,
  controlPlaneCall,
  createDarkLaunchApp,
  createWrongAppFlag,
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
 * Each proof owns disposable probe Apps so it can establish the complete
 * precondition instead of depending on opaque, potentially stale fixture keys.
 */
export async function runNegativeProofs(deps, resources, keys, resolve, journeyLiveVariant) {
  const probes = { apps: [] };

  try {
    const wrongApp = await proveWrongAppIsolation(
      deps,
      resources,
      keys,
      probes,
      resolve,
      journeyLiveVariant,
    );

    const revokedKeyMaterial = await createRevokedClientKey(deps, resources, keys, probes);
    const revokedCredential = await assertStructuredAuthFailure(
      () =>
        resolve("verify", {
          clientKey: revokedKeyMaterial,
          targetingKey: keys.targetedKey,
          attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
        }),
      "CREDENTIAL_REVOKED",
      "revoked credential",
    );

    const crossOrganization = await proveCrossOrganizationWriteRejected(deps, keys);
    return { wrongApp, revokedCredential, crossOrganization };
  } finally {
    for (const probe of probes.apps) {
      if (probe.flagId) await deleteFlag(deps, probe.appId, probe.flagId);
      await deleteApp(deps, probe.appId);
    }
  }
}

async function proveWrongAppIsolation(deps, resources, keys, probes, resolve, journeyLiveVariant) {
  const wrongKeys = {
    ...keys,
    appKey: `${keys.appKey}-wrong`,
    appName: `${keys.appName} Wrong`,
  };
  const wrongApp = await createDarkLaunchApp(deps, wrongKeys);
  const wrongProbe = { appId: wrongApp.app.id, flagId: null };
  probes.apps.push(wrongProbe);
  resources.transientAppKeys.push(wrongKeys.appKey);
  const wrongDev = wrongApp.environments.find((environment) => environment.key === "dev");
  if (!wrongDev) throw new Error("wrong-App create missing dev Environment");
  const clientKey = await getClientKey(deps, wrongApp.app.id, wrongDev.id);
  const flag = await createWrongAppFlag(deps, wrongApp.app.id, keys.flagKey);
  wrongProbe.flagId = flag.id;
  await updateFlagConfig(deps, wrongApp.app.id, wrongDev.id, flag.id, {
    enabled: true,
    availableVariantNames: ["wrong-app-only", "journey-decoy"],
  });

  const deadline = Date.now() + (deps.propagationWindowMs ?? PROPAGATION_WINDOW_MS);
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const details = await resolve("verify", {
        clientKey: clientKey.keyMaterial,
        targetingKey: keys.targetedKey,
        attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
      });
      assertVariant(details, "wrong-app-only", "wrong-App same-key Flag");
      if (details.variantName === journeyLiveVariant) {
        throw new Error("wrong-App Client Key resolved the journey App's live-Run Variant");
      }
      return {
        sameFlagKey: keys.flagKey,
        resolvedVariant: details.variantName,
        journeyLiveVariant,
        isolated: true,
      };
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("wrong-App same-key Flag did not converge within the propagation window");
}

async function createRevokedClientKey(deps, resources, keys, probes) {
  const probeKeys = {
    ...keys,
    appKey: `${keys.appKey}-revoked`,
    appName: `${keys.appName} Revoked`,
  };
  const probeApp = await createDarkLaunchApp(deps, probeKeys);
  probes.apps.push({ appId: probeApp.app.id });
  resources.transientAppKeys.push(probeKeys.appKey);
  const probeDev = probeApp.environments.find((environment) => environment.key === "dev");
  if (!probeDev) throw new Error("revoked-probe App create missing dev Environment");
  const priorKey = clientKeyMaterialFromCreate(probeApp, probeDev.id);
  await rotateClientKey(deps, probeApp.app.id, probeDev.id);
  return priorKey;
}

async function proveCrossOrganizationWriteRejected(deps, keys) {
  if (typeof deps.foreignOrgId !== "string" || deps.foreignOrgId.length === 0) {
    throw new Error("cross-Organization proof requires a seeded foreignOrgId");
  }
  const foreignOrgId = deps.foreignOrgId;
  const crossKey = `${keys.appKey}-cross-org`;
  const body = {
    orgId: foreignOrgId,
    organizationId: foreignOrgId,
    name: "Should Fail",
    key: crossKey,
    description: "Unauthorized cross-Organization mutation probe.",
    idempotency_key: crossKey,
  };
  const crossOrg = await crossOrgCreate(deps, foreignOrgId, body);
  const code = requireForbidden(crossOrg, "cross-Organization mutation");

  if (deps.orgId) {
    const apps = await listApps(deps, deps.orgId);
    const items = Array.isArray(apps) ? apps : (apps.items ?? apps.apps ?? []);
    if (items.some((app) => app.key === crossKey)) {
      throw new Error(`cross-Organization write leaked App key ${crossKey} into smoke Org`);
    }
  }

  const followUp = await crossOrgList(deps, foreignOrgId);
  const followUpCode = requireForbidden(followUp, "cross-Organization list");
  return { foreignOrgId, writeCode: code, listCode: followUpCode };
}

function crossOrgCreate(deps, foreignOrgId, body) {
  return deps.callToolResult
    ? deps.callToolResult("apps_create", body)
    : controlPlaneCall(deps, "POST", `/orgs/${foreignOrgId}/apps`, body, body.idempotency_key);
}

function crossOrgList(deps, foreignOrgId) {
  return deps.callToolResult
    ? deps.callToolResult("apps_list", { orgId: foreignOrgId })
    : controlPlaneCall(deps, "GET", `/orgs/${foreignOrgId}/apps`);
}

function requireForbidden(result, label) {
  if (result.ok) throw new Error(`${label} unexpectedly succeeded`);
  const code = result.body && typeof result.body === "object" ? result.body.code : undefined;
  if (code !== "FORBIDDEN") {
    throw new Error(
      `${label} expected FORBIDDEN, got HTTP ${result.status} body=${JSON.stringify(result.body)}`,
    );
  }
  return code;
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
  return { errorCode: details.errorCode, reason: details.reason };
}

export async function cleanupDarkLaunch(deps, resources, keys) {
  const activeKeyBefore = resources.clientKeyMaterial;
  const report = {
    runEnded: resources.runId === null,
    experimentDeleted: resources.experimentId === null,
    flagDeleted: resources.flagId === null,
    appDeleted: !resources.ownsApp || resources.appId === null,
    credentialRevoked: !resources.ownsApp,
  };

  if (resources.runId) {
    await endRun(deps, resources);
    resources.runId = null;
    report.runEnded = true;
  }

  if (resources.experimentId) {
    await deleteExperiment(deps, resources);
    resources.experimentId = null;
    report.experimentDeleted = true;
  }

  if (resources.appId && resources.flagId) {
    await deleteFlag(deps, resources.appId, resources.flagId);
    resources.flagId = null;
    report.flagDeleted = true;
  }

  if (resources.ownsApp && resources.appId) {
    await deleteApp(deps, resources.appId);
    resources.appId = null;
    report.appDeleted = true;
    if (deps.assertCredentialRevoked && activeKeyBefore) {
      await deps.assertCredentialRevoked({ clientKey: activeKeyBefore, flagKey: keys.flagKey });
      report.credentialRevoked = true;
    }
  }

  const firstScan = await assertNoOrphans(deps, resources, keys, activeKeyBefore);
  await new Promise((resolvePromise) =>
    setTimeout(resolvePromise, deps.cleanupStabilityWindowMs ?? 2_000),
  );
  const finalScan = await assertNoOrphans(deps, resources, keys, activeKeyBefore);
  return { ...report, orphanScans: [firstScan, finalScan] };
}

async function assertNoOrphans(deps, resources, keys, activeKeyBefore) {
  const apps = await scanOrphanApps(deps, resources, keys);
  const appResources = await scanRemainingAppResources(deps, resources, keys, activeKeyBefore);
  return { apps, ...appResources };
}

async function scanOrphanApps(deps, resources, keys) {
  if (!deps.orgId) return [];
  const apps = await listApps(deps, deps.orgId);
  const items = Array.isArray(apps) ? apps : (apps.items ?? apps.apps ?? []);
  const watchedKeys = new Set([
    keys.appKey,
    `${keys.appKey}-wrong`,
    `${keys.appKey}-revoked`,
    `${keys.appKey}-cross-org`,
    ...resources.transientAppKeys,
  ]);
  const orphaned = items.filter((app) => watchedKeys.has(app.key));
  if (orphaned[0]) {
    throw new Error(`cleanup left orphaned App ${orphaned[0].id} (${orphaned[0].key})`);
  }
  return orphaned.map((app) => app.key);
}

async function scanRemainingAppResources(deps, resources, keys, activeKeyBefore) {
  if (!resources.appId) return { flags: [], credentialStable: null };
  const flags = await listFlags(deps, resources.appId);
  const flagItems = Array.isArray(flags) ? flags : (flags.items ?? []);
  const orphaned = flagItems.filter((flag) => flag.key === keys.flagKey);
  if (orphaned[0]) {
    throw new Error(`cleanup left orphaned Flag ${orphaned[0].id} (${orphaned[0].key})`);
  }
  const credentialStable = await assertCredentialStable(deps, resources, activeKeyBefore);
  return { flags: orphaned.map((flag) => flag.key), credentialStable };
}

async function assertCredentialStable(deps, resources, activeKeyBefore) {
  if (!resources.environmentId || !activeKeyBefore) return null;
  const activeKey = await getClientKey(deps, resources.appId, resources.environmentId);
  if (activeKey.keyMaterial !== activeKeyBefore) {
    throw new Error("cleanup left rotated Client Key on journey App (expected stable material)");
  }
  if (activeKey.revokedAt) {
    throw new Error("journey App active Client Key is revoked after cleanup");
  }
  return true;
}
