/** Negative proofs and cleanup for the dark-launch journey. */

import { proveWrongAppIsolation } from "./app-isolation-proof.mjs";
import { captureCleanupFailure, throwPrimaryWithCleanup } from "./cleanup-failures.mjs";
import { COHORT_ATTRIBUTE, COHORT_VALUE } from "./constants.mjs";
import {
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
 * Each proof owns disposable probe Apps so it can establish the complete
 * precondition instead of depending on opaque, potentially stale fixture keys.
 */
export async function runNegativeProofs(deps, resources, keys, resolve, journeyLiveVariant) {
  const probes = { apps: [], flags: [] };
  let result;
  let proofFailure;

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

    const crossOrganization = await proveCrossOrganizationWriteRejected(deps, keys, probes);
    result = { wrongApp, revokedCredential, crossOrganization };
  } catch (error) {
    proofFailure = error;
  }

  const cleanupFailures = [];
  for (const probe of probes.flags.reverse()) {
    await captureCleanupFailure(cleanupFailures, `delete probe Flag ${probe.flagId}`, () =>
      deleteFlag(deps, probe.appId, probe.flagId),
    );
  }
  for (const appId of probes.apps.reverse()) {
    await captureCleanupFailure(cleanupFailures, `delete probe App ${appId}`, () =>
      deleteApp(deps, appId),
    );
  }
  throwPrimaryWithCleanup(
    proofFailure,
    cleanupFailures,
    "negative authorization proof failed and probe cleanup also failed",
  );
  return result;
}

async function createRevokedClientKey(deps, resources, keys, probes) {
  const probeKeys = {
    ...keys,
    appKey: `${keys.appKey}-revoked`,
    appName: `${keys.appName} Revoked`,
  };
  const probeApp = await createDarkLaunchApp(deps, probeKeys);
  probes.apps.push(probeApp.app.id);
  resources.transientAppKeys.push(probeKeys.appKey);
  const probeDev = probeApp.environments.find((environment) => environment.key === "dev");
  if (!probeDev) throw new Error("revoked-probe App create missing dev Environment");
  const priorKey = await getClientKey(deps, probeApp.app.id, probeDev.id);
  await rotateClientKey(deps, probeApp.app.id, probeDev.id);
  return priorKey.keyMaterial;
}

async function proveCrossOrganizationWriteRejected(deps, keys, probes) {
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
  if (crossOrg.ok) {
    const createdAppId = crossOrg.body?.app?.id ?? crossOrg.body?.id;
    if (typeof createdAppId === "string") probes.apps.push(createdAppId);
  }
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
  const { orgId: _orgId, ...httpBody } = body;
  return deps.callToolResult
    ? deps.callToolResult("apps_create", body)
    : controlPlaneCall(deps, "POST", `/orgs/${foreignOrgId}/apps`, httpBody, body.idempotency_key);
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
  const failures = [];
  const report = {
    runEnded: resources.runId === null,
    experimentDeleted: resources.experimentId === null,
    flagDeleted: resources.flagId === null,
    appDeleted: !resources.ownsApp || resources.appId === null,
    credentialRevoked: !resources.ownsApp,
  };

  if (resources.runId) {
    await captureCleanupFailure(
      failures,
      `end Run ${resources.runId}`,
      () => endRun(deps, resources),
      () => {
        resources.runId = null;
        report.runEnded = true;
      },
    );
  }

  if (resources.experimentId) {
    await captureCleanupFailure(
      failures,
      `delete Experiment ${resources.experimentId}`,
      () => deleteExperiment(deps, resources),
      () => {
        resources.experimentId = null;
        report.experimentDeleted = true;
      },
    );
  }

  if (resources.appId && resources.flagId) {
    await captureCleanupFailure(
      failures,
      `delete Flag ${resources.flagId}`,
      () => deleteFlag(deps, resources.appId, resources.flagId),
      () => {
        resources.flagId = null;
        report.flagDeleted = true;
      },
    );
  }

  if (resources.ownsApp && resources.appId) {
    const appId = resources.appId;
    await captureCleanupFailure(
      failures,
      `delete App ${appId}`,
      () => deleteApp(deps, appId),
      () => {
        resources.appId = null;
        report.appDeleted = true;
      },
    );
    if (report.appDeleted && deps.assertCredentialRevoked && activeKeyBefore) {
      await captureCleanupFailure(
        failures,
        `verify credential revocation for App ${appId}`,
        () => deps.assertCredentialRevoked({ clientKey: activeKeyBefore, flagKey: keys.flagKey }),
        () => {
          report.credentialRevoked = true;
        },
      );
    }
  }

  let firstScan;
  await captureCleanupFailure(
    failures,
    "first orphan scan",
    () => assertNoOrphans(deps, resources, keys, activeKeyBefore),
    (scan) => {
      firstScan = scan;
    },
  );
  await new Promise((resolvePromise) =>
    setTimeout(resolvePromise, deps.cleanupStabilityWindowMs ?? 2_000),
  );
  let finalScan;
  await captureCleanupFailure(
    failures,
    "final orphan scan",
    () => assertNoOrphans(deps, resources, keys, activeKeyBefore),
    (scan) => {
      finalScan = scan;
    },
  );
  throwPrimaryWithCleanup(undefined, failures, "one or more dark-launch cleanup steps failed");
  return { ...report, orphanScans: [firstScan, finalScan] };
}

async function assertNoOrphans(deps, resources, keys, activeKeyBefore) {
  const apps = await scanOrphanApps(deps, resources, keys);
  const appResources = await scanRemainingAppResources(deps, resources, keys, activeKeyBefore);
  return { apps, ...appResources };
}

async function scanOrphanApps(deps, resources, keys) {
  if (!deps.orgId) return { checkedKeys: [], matchedKeys: [] };
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
  return { checkedKeys: [...watchedKeys].sort(), matchedKeys: [] };
}

async function scanRemainingAppResources(deps, resources, keys, activeKeyBefore) {
  if (!resources.appId) {
    return { flags: { checkedKeys: [], matchedKeys: [] }, credentialStable: null };
  }
  const flags = await listFlags(deps, resources.appId);
  const flagItems = Array.isArray(flags) ? flags : (flags.items ?? []);
  const checkedKeys = [keys.flagKey, `${keys.flagKey}-journey-only`];
  const orphaned = flagItems.filter((flag) => checkedKeys.includes(flag.key));
  if (orphaned[0]) {
    throw new Error(`cleanup left orphaned Flag ${orphaned[0].id} (${orphaned[0].key})`);
  }
  const credentialStable = await assertCredentialStable(deps, resources, activeKeyBefore);
  return { flags: { checkedKeys, matchedKeys: [] }, credentialStable };
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
