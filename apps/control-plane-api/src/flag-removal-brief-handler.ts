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
  const catalogPromise = deps.repo.flags.listVariantsForFlags(scope, [flag.id]);
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
  const defaultVariant = definition.variants.find(
    (variant) => variant.id === definition.defaultVariantId,
  );
  if (!defaultVariant) {
    throw new Error(`flag_removal_brief: Flag ${flag.id} defaultVariantId names no Variant`);
  }
  const envKeyById = new Map(environments.map((environment) => [environment.id, environment.key]));
  const servings = hydratedFlag.configurations.map((configuration) => {
    const environmentKey = envKeyById.get(configuration.environmentId);
    if (!environmentKey) {
      throw new Error(
        `flag_removal_brief: Configuration names unknown Environment ${configuration.environmentId}`,
      );
    }
    return analyzeEnvironmentServing({
      environmentId: configuration.environmentId,
      environmentKey,
      configuration,
      defaultVariantName: defaultVariant.name,
      variants: definition.variants,
    });
  });
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
