import {
  FLAG_REMOVAL_BRIEF_CAVEATS,
  FlagRemovalBriefResponseSchema,
  flagRemovalSdkCallShapes,
} from "@splitch/contracts";
import { appScope } from "@splitch/db";
import { renderError, type HandlerArgs } from "@splitch/worker-runtime";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils";
import { FlagConfigurationMissingError, hydrateFlags } from "./flag-definition-hydration";
import { flagFrom } from "./flag-definition-model";
import { flagNotFound } from "./flag-definition-errors";
import { pathParam } from "./handler-input";
import { analyzeEnvironmentServing, removalUniformity } from "./flag-removal-serving";

/**
 * Read-only advisory brief an agent can act on in the customer's codebase.
 * Never writes code and never claims repository evidence.
 */
export async function getFlagRemovalBrief(
  deps: FlagDefinitionDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const flagId = pathParam(input, "flagId");
  const scope = appScope(appId);
  const flag = await deps.repo.flags.getFlag(scope, flagId);
  if (!flag) return flagNotFound(requestId);

  const environments = await deps.repo.identity.listEnvironments(scope);
  const environmentIds = environments.map((environment) => environment.id);
  const catalogPromise = deps.repo.flags.listVariantsForFlags(scope, [flag.id]);
  // Per-Environment defaultVariantId is stored on flag_configs and can diverge
  // from the App-level Flag default after a later catalog change.
  const configsPromise = deps.repo.flags.listFlagConfigsByFlagIdsAcrossEnvironments(
    scope,
    [flag.id],
    environmentIds,
  );
  let hydrated: Awaited<ReturnType<typeof hydrateFlags>>;
  try {
    hydrated = await hydrateFlags(deps, appId, [flag], catalogPromise);
  } catch (cause) {
    if (!(cause instanceof FlagConfigurationMissingError)) throw cause;
    return renderError(
      {
        code: "INTERNAL_SERVER_ERROR",
        message: `Flag ${cause.flagId} has no Configuration in Environment ${cause.environmentId}`,
        details: {},
      },
      { requestId },
    );
  }
  const hydratedFlag = hydrated[0];
  if (!hydratedFlag) {
    throw new Error("flag_removal_brief: hydrateFlags returned no Flag");
  }
  const definition = flagFrom(flag, (await catalogPromise).get(flag.id) ?? []);
  const defaultVariantIdByEnv = new Map(
    (await configsPromise).map((config) => {
      if (!config.defaultVariantId) {
        throw new Error(
          `flag_removal_brief: Flag Configuration ${config.id} has no defaultVariantId`,
        );
      }
      return [config.environmentId, config.defaultVariantId] as const;
    }),
  );
  const envKeyById = new Map(environments.map((environment) => [environment.id, environment.key]));
  const servings = await Promise.all(
    hydratedFlag.configurations.map(async (configuration) => {
      const environmentKey = envKeyById.get(configuration.environmentId);
      if (!environmentKey) {
        throw new Error(
          `flag_removal_brief: Configuration names unknown Environment ${configuration.environmentId}`,
        );
      }
      const defaultVariantId = defaultVariantIdByEnv.get(configuration.environmentId);
      if (!defaultVariantId) {
        throw new Error(
          `flag_removal_brief: Flag ${flag.id} has no Configuration default in Environment ${configuration.environmentId}`,
        );
      }
      return analyzeEnvironmentServing({
        appId,
        flagKey: definition.key,
        environmentId: configuration.environmentId,
        environmentKey,
        enabled: configuration.enabled,
        defaultVariantId,
        availableVariantNames: configuration.availableVariantNames,
        targetingRulesCount: configuration.targetingRules.length,
        rollout: configuration.rollout,
        hasLiveExperiment: configuration.experiment !== null,
        variants: definition.variants,
      });
    }),
  );
  const uniformity = removalUniformity(servings);
  return Response.json(
    FlagRemovalBriefResponseSchema.parse({
      flagId: definition.id,
      flagKey: definition.key,
      variants: definition.variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        value: variant.value,
      })),
      lifecycleClass: definition.lifecycleClass,
      owner: definition.owner,
      expiresAt: definition.expiresAt,
      environments: servings,
      ...uniformity,
      sdkCallShapes: flagRemovalSdkCallShapes(definition.key),
      caveats: [...FLAG_REMOVAL_BRIEF_CAVEATS],
    }),
  );
}
