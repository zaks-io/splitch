/**
 * Shared dark-launch journey against a Control Plane + Evaluation pair.
 * Uses only normal Control Plane operations (no direct D1/KV/Tinybird writes).
 */

export {
  assertVariant,
  DEFAULT_VARIANT,
  LAUNCH_VARIANT,
  PROPAGATION_WINDOW_MS,
  syntheticKeys,
  variantName,
} from "./constants.mjs";
export { listApps, listFlags } from "./control-plane.mjs";

import {
  assertVariant,
  COHORT_ATTRIBUTE,
  COHORT_VALUE,
  DEFAULT_VARIANT,
  LAUNCH_VARIANT,
  PROPAGATION_WINDOW_MS,
  syntheticKeys,
} from "./constants.mjs";
import { cleanupDarkLaunch, runNegativeProofs } from "./cleanup.mjs";
import {
  clientKeyMaterialFromCreate,
  createDarkLaunchApp,
  createDarkLaunchFlag,
  getClientKey,
  replaceTargetingRules,
  updateFlagConfig,
} from "./control-plane.mjs";

/**
 * Full dark-launch journey.
 *
 * When `deps.appId` + `deps.environmentId` are set (shared-preview smoke App), the
 * journey creates only a transient Flag on that App. Otherwise it creates a
 * transient App (local harness / open org token).
 */
export async function runDarkLaunchJourney(deps) {
  const keys = syntheticKeys(deps.runId);
  const ownsApp = !deps.appId;
  const resources = {
    appId: deps.appId ?? null,
    flagId: null,
    clientKeyMaterial: null,
    environmentId: deps.environmentId ?? null,
    ownsApp,
    transientAppKeys: [],
  };
  const steps = [];

  try {
    if (ownsApp) {
      const created = await createDarkLaunchApp(deps, keys);
      resources.appId = created.app.id;
      const dev = created.environments.find((environment) => environment.key === "dev");
      if (!dev) throw new Error("apps_create did not provision a dev Environment");
      resources.environmentId = dev.id;
      resources.clientKeyMaterial = clientKeyMaterialFromCreate(created, dev.id);
      steps.push("apps_create");
    } else {
      if (!resources.appId || !resources.environmentId) {
        throw new Error("existing App mode requires appId and environmentId");
      }
      const clientKey = await getClientKey(deps, resources.appId, resources.environmentId);
      resources.clientKeyMaterial = clientKey.keyMaterial;
      steps.push("reuse_smoke_app");
    }

    const flag = await createDarkLaunchFlag(deps, resources.appId, keys.flagKey);
    resources.flagId = flag.id;
    const launchVariant = flag.variants.find((variant) => variant.name === LAUNCH_VARIANT);
    if (!launchVariant) throw new Error("flags_create missing launch Variant");
    steps.push("flags_create");

    const resolve = (action, options) =>
      deps.resolve(action, {
        clientKey: options.clientKey ?? resources.clientKeyMaterial,
        endpoint: deps.evaluationBaseUrl,
        flagKey: keys.flagKey,
        targetingKey: options.targetingKey,
        attributes: options.attributes ?? {},
        idempotencyKey: options.idempotencyKey,
      });

    await proveDisabledDefault(resolve, keys);
    steps.push("disabled_default_variant");

    await enableTargetedRule(deps, resources, keys, launchVariant.id);
    steps.push("enable_targeted_rule");

    const windowMs = deps.propagationWindowMs ?? PROPAGATION_WINDOW_MS;
    await waitForVariant(resolve, {
      targetingKey: keys.targetedKey,
      attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
      expected: LAUNCH_VARIANT,
      label: "enabled targeted verify",
      windowMs,
    });
    await waitForVariant(resolve, {
      targetingKey: keys.untargetedKey,
      attributes: { [COHORT_ATTRIBUTE]: "other" },
      expected: DEFAULT_VARIANT,
      label: "enabled untargeted verify",
      windowMs,
    });
    steps.push("targeted_cohort_split");

    if (deps.assertVerifyClean) await deps.assertVerifyClean();
    steps.push("verify_zero_exposure_writes");

    await proveEvaluateObservation(deps, resolve, keys);
    steps.push("evaluate_idempotent_observation");

    await updateFlagConfig(deps, resources.appId, resources.environmentId, resources.flagId, {
      enabled: false,
    });
    steps.push("kill_switch_off");

    await waitForVariant(resolve, {
      targetingKey: keys.targetedKey,
      attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
      expected: DEFAULT_VARIANT,
      label: "kill-switch targeted",
      windowMs,
    });
    await waitForVariant(resolve, {
      targetingKey: keys.untargetedKey,
      attributes: { [COHORT_ATTRIBUTE]: "other" },
      expected: DEFAULT_VARIANT,
      label: "kill-switch untargeted",
      windowMs,
    });
    steps.push("kill_switch_default_variant");

    await runNegativeProofs(deps, resources, keys, resolve);
    steps.push("negative_proofs");

    return { keys, resources: { ...resources }, steps };
  } finally {
    await cleanupDarkLaunch(deps, resources, keys);
  }
}

async function proveDisabledDefault(resolve, keys) {
  assertVariant(
    await resolve("verify", {
      targetingKey: keys.targetedKey,
      attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    }),
    DEFAULT_VARIANT,
    "disabled targeted verify",
  );
  assertVariant(
    await resolve("verify", {
      targetingKey: keys.untargetedKey,
      attributes: { [COHORT_ATTRIBUTE]: "other" },
    }),
    DEFAULT_VARIANT,
    "disabled untargeted verify",
  );
}

async function enableTargetedRule(deps, resources, keys, launchVariantId) {
  await updateFlagConfig(deps, resources.appId, resources.environmentId, resources.flagId, {
    enabled: true,
    availableVariantNames: [DEFAULT_VARIANT, LAUNCH_VARIANT],
  });
  await replaceTargetingRules(deps, resources.appId, resources.environmentId, resources.flagId, [
    {
      id: keys.ruleId,
      flagId: resources.flagId,
      priority: 0,
      conditions: [{ attribute: COHORT_ATTRIBUTE, operator: "eq", value: COHORT_VALUE }],
      variantId: launchVariantId,
      percentageRollout: null,
    },
  ]);
}

async function proveEvaluateObservation(deps, resolve, keys) {
  const idempotencyKey = `dark-launch-eval-${deps.runId}`;
  const first = await resolve("evaluate", {
    targetingKey: keys.targetedKey,
    attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    idempotencyKey,
  });
  assertVariant(first, LAUNCH_VARIANT, "first evaluate");
  const retry = await resolve("evaluate", {
    targetingKey: keys.targetedKey,
    attributes: { [COHORT_ATTRIBUTE]: COHORT_VALUE },
    idempotencyKey,
  });
  assertVariant(retry, LAUNCH_VARIANT, "retry evaluate");
  if (deps.assertEvaluateObservation) {
    await deps.assertEvaluateObservation({ idempotencyKey, first, retry });
  }
}

async function waitForVariant(resolve, options) {
  const deadline = Date.now() + options.windowMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const details = await resolve("verify", {
        targetingKey: options.targetingKey,
        attributes: options.attributes,
      });
      assertVariant(details, options.expected, options.label);
      return details;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${options.label}: Variant did not propagate within ${options.windowMs}ms`);
}
