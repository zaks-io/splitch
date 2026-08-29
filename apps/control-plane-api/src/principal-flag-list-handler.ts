import {
  boundListRead,
  type HydratedPrincipalFlagResponse,
  HydratedPrincipalFlagResponseSchema,
  MEMBERSHIP_WIDE_READ_AUTHORIZATION,
  type PrincipalFlagResponse,
  PrincipalFlagResponseSchema,
} from "@splitch/contracts";
import { multiAppScope } from "@splitch/db";
import {
  appAccessCovers,
  type HandlerArgs,
  organizationAccessCovers,
  renderError,
  requireWideMemberships,
} from "@splitch/worker-runtime";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils";
import { composeHydratedFlags } from "./flag-definition-hydration";
import { flagFrom } from "./flag-definition-model";
import { optionalQueryParam } from "./handler-input";
import { FLAG_LIST_READ_LIMIT } from "./overview-thresholds";

/** Every readable Flag across the live membership set, bounded globally. */
export async function listPrincipalFlags(
  deps: FlagDefinitionDeps,
  { input, principal, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  if (principal.authorization !== MEMBERSHIP_WIDE_READ_AUTHORIZATION) {
    return renderError(
      {
        code: "FORBIDDEN",
        message: "membership-wide read authorization is required",
        details: {},
      },
      { requestId },
    );
  }

  const memberships = requireWideMemberships(principal);
  const appIds = memberships.apps
    .filter(
      (membership) =>
        organizationAccessCovers(principal, membership.organizationId) &&
        appAccessCovers(principal, membership.id),
    )
    .map((membership) => membership.id);
  const scope = multiAppScope(appIds);
  const [descriptors, scanned] = await Promise.all([
    deps.repo.flags.listAppDescriptors(scope),
    deps.repo.flags.listFlagPageAcrossApps(scope, FLAG_LIST_READ_LIMIT + 1),
  ]);
  const page = boundListRead(scanned, FLAG_LIST_READ_LIMIT);
  const descriptorByAppId = new Map(
    descriptors.map((descriptor) => [descriptor.appId, descriptor]),
  );
  const flagIds = page.items.map((row) => row.id);
  const catalogsResult = deps.repo.flags.listVariantsForFlagsAcrossApps(scope, flagIds);
  const include = optionalQueryParam(input, "include");
  const requestedEnvironmentIds = optionalQueryParam(input, "envs")?.split(",");

  let composed: Array<PrincipalFlagResponse | HydratedPrincipalFlagResponse>;
  if (include === "config") {
    composed = await hydratedItems(
      deps,
      scope,
      page.items,
      catalogsResult,
      descriptorByAppId,
      requestedEnvironmentIds,
    );
  } else {
    const catalogs = await catalogsResult;
    composed = page.items.map((row) => {
      const descriptor = requireDescriptor(descriptorByAppId, row.appId);
      return PrincipalFlagResponseSchema.parse({
        ...flagFrom(row, catalogs.get(row.id) ?? []),
        org: { id: descriptor.orgId, slug: descriptor.orgSlug },
        app: { id: descriptor.appId, key: descriptor.appKey },
      });
    });
  }

  return Response.json({ ...page, items: composed });
}

async function hydratedItems(
  deps: FlagDefinitionDeps,
  scope: ReturnType<typeof multiAppScope>,
  rows: Awaited<ReturnType<FlagDefinitionDeps["repo"]["flags"]["listFlagPageAcrossApps"]>>,
  catalogsResult: ReturnType<FlagDefinitionDeps["repo"]["flags"]["listVariantsForFlagsAcrossApps"]>,
  descriptorByAppId: ReadonlyMap<
    string,
    { orgId: string; orgSlug: string; appId: string; appKey: string }
  >,
  requestedEnvironmentIds?: readonly string[],
) {
  const flagIds = rows.map((row) => row.id);
  const [catalogs, environments, configs, targetingRules, experiments] = await Promise.all([
    catalogsResult,
    deps.repo.flags.listEnvironmentsAcrossApps(scope),
    deps.repo.flags.listFlagConfigsAcrossApps(scope, flagIds),
    deps.repo.flags.listTargetingRulesAcrossApps(scope, flagIds),
    deps.repo.flags.listRunningExperimentsAcrossApps(scope, flagIds),
  ]);
  return composeHydratedFlags(
    rows,
    catalogs,
    environments,
    configs,
    targetingRules,
    experiments,
    requestedEnvironmentIds,
  ).map((flag, index) => {
    const row = rows[index];
    if (!row) throw new Error("principal Flag hydration lost its source row");
    const descriptor = requireDescriptor(descriptorByAppId, row.appId);
    return HydratedPrincipalFlagResponseSchema.parse({
      ...flag,
      org: { id: descriptor.orgId, slug: descriptor.orgSlug },
      app: { id: descriptor.appId, key: descriptor.appKey },
    });
  });
}

function requireDescriptor(
  descriptors: ReadonlyMap<
    string,
    { orgId: string; orgSlug: string; appId: string; appKey: string }
  >,
  appId: string,
) {
  const descriptor = descriptors.get(appId);
  if (!descriptor) throw new Error(`principal Flag list: App ${appId} has no descriptor`);
  return descriptor;
}
