import {
  assertVariant,
  COHORT_ATTRIBUTE,
  COHORT_VALUE,
  PROPAGATION_WINDOW_MS,
} from "./constants.mjs";
import {
  createDarkLaunchApp,
  createIsolationProbeFlag,
  getClientKey,
  updateFlagConfig,
} from "./control-plane.mjs";

const WRONG_APP_VARIANT = "wrong-app-only";
const JOURNEY_ONLY_VARIANT = "journey-app-only";

export async function proveWrongAppIsolation(
  deps,
  resources,
  keys,
  probes,
  resolve,
  journeyLiveVariant,
) {
  const journeyOnlyFlagKey = `${keys.flagKey}-journey-only`;
  const journeyFlag = await createIsolationProbeFlag(
    deps,
    resources.appId,
    journeyOnlyFlagKey,
    JOURNEY_ONLY_VARIANT,
  );
  probes.flags.push({ appId: resources.appId, flagId: journeyFlag.id });
  await updateFlagConfig(deps, resources.appId, resources.environmentId, journeyFlag.id, {
    enabled: true,
    availableVariantNames: [JOURNEY_ONLY_VARIANT, "journey-decoy"],
  });

  await waitForVariant(
    deps,
    () => resolve("verify", resolutionOptions(keys, journeyOnlyFlagKey)),
    JOURNEY_ONLY_VARIANT,
    "journey-only Flag",
  );

  const wrongKeys = {
    ...keys,
    appKey: `${keys.appKey}-wrong`,
    appName: `${keys.appName} Wrong`,
  };
  const wrongApp = await createDarkLaunchApp(deps, wrongKeys);
  probes.apps.push(wrongApp.app.id);
  resources.transientAppKeys.push(wrongKeys.appKey);
  const wrongDev = wrongApp.environments.find((environment) => environment.key === "dev");
  if (!wrongDev) throw new Error("wrong-App create missing dev Environment");
  const clientKey = await getClientKey(deps, wrongApp.app.id, wrongDev.id);
  const sameKeyFlag = await createIsolationProbeFlag(
    deps,
    wrongApp.app.id,
    keys.flagKey,
    WRONG_APP_VARIANT,
  );
  probes.flags.push({ appId: wrongApp.app.id, flagId: sameKeyFlag.id });
  await updateFlagConfig(deps, wrongApp.app.id, wrongDev.id, sameKeyFlag.id, {
    enabled: true,
    availableVariantNames: [WRONG_APP_VARIANT, "journey-decoy"],
  });

  const sameKey = await waitForVariant(
    deps,
    () => resolve("verify", resolutionOptions(keys, keys.flagKey, clientKey.keyMaterial)),
    WRONG_APP_VARIANT,
    "wrong-App same-key Flag",
  );
  if (sameKey.variantName === journeyLiveVariant) {
    throw new Error("wrong-App Client Key resolved the journey App's live-Run Variant");
  }

  const scopedMiss = await resolve(
    "verify",
    resolutionOptions(keys, journeyOnlyFlagKey, clientKey.keyMaterial),
  );
  if (scopedMiss.reason !== "ERROR" || scopedMiss.errorCode !== "FLAG_NOT_FOUND") {
    throw new Error(
      `wrong-App scoped miss expected FLAG_NOT_FOUND, got ${JSON.stringify(scopedMiss)}`,
    );
  }

  return {
    sameFlagKey: keys.flagKey,
    resolvedVariant: sameKey.variantName,
    journeyLiveVariant,
    journeyOnlyFlagKey,
    scopedMissErrorCode: scopedMiss.errorCode,
    isolated: true,
  };
}

function resolutionOptions(keys, flagKey, clientKey) {
  return {
    clientKey,
    flagKey,
    targetingKey: keys.targetedKey,
    attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
  };
}

async function waitForVariant(deps, action, expected, label) {
  const deadline = Date.now() + (deps.propagationWindowMs ?? PROPAGATION_WINDOW_MS);
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const details = await action();
      assertVariant(details, expected, label);
      return details;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} did not converge within the propagation window`);
}
