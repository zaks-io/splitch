import type { Variant } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { appNotFound, nowIso } from "./app-environment-model";
import { flagNotFound, validationErrors } from "./flag-definition-errors";
import {
  type FlagDefinitionDeps,
  fail,
  type LoadedFlag,
  loadWritableFlag,
  ok,
  type Result,
  serializeSchema,
} from "./flag-definition-handler-utils";
import {
  flagFrom,
  flagResponse,
  flagWithConfigurationFrom,
  schemaFromBody,
  variantSchemaIssues,
} from "./flag-definition-model";
import { schemaDefinitionIssues } from "./flag-definition-schema";
import { objectBody, optionalQueryParam, pathParam } from "./handler-input";
import { FLAG_LIST_READ_LIMIT } from "./overview-thresholds";

/**
 * The App's Flag catalog: bounded, newest first, and honest about the bound.
 *
 * This is the screen the Overview's truncation notice sends an operator to, so
 * it is the one list that must not answer "too much data to show you" with
 * another read whose cost is the App's whole catalog plus a query per row.
 */
export async function listFlags(
  deps: FlagDefinitionDeps,
  { input, requestId }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(requestId);
  const environmentId = optionalQueryParam(input, "environmentId");
  if (environmentId && !(await deps.repo.identity.getEnvironment(appScope(appId), environmentId))) {
    return appNotFound(requestId);
  }

  const scope = appScope(appId);
  // One row past the ceiling, so truncation is OBSERVED rather than inferred
  // from a full page — a page of exactly `readLimit` rows is what a complete
  // catalog of that size also looks like.
  const scanned = await deps.repo.flags.listFlagPage(scope, FLAG_LIST_READ_LIMIT + 1);
  const readTruncated = scanned.length > FLAG_LIST_READ_LIMIT;
  const rows = readTruncated ? scanned.slice(0, FLAG_LIST_READ_LIMIT) : scanned;
  // ONE catalog read for the whole page. Resolving Variants per row made this
  // list cost a D1 query per Flag, on exactly the App large enough to be sent
  // here in the first place.
  const catalogs = await deps.repo.flags.listVariantsForFlags(
    scope,
    rows.map((row) => row.id),
  );
  const items = environmentId
    ? withEnvironmentConfigurations(deps, appId, environmentId, rows, catalogs)
    : Promise.resolve(rows.map((row) => flagFrom(row, catalogs.get(row.id) ?? [])));
  return Response.json({
    items: await items,
    readTruncated,
    readLimit: FLAG_LIST_READ_LIMIT,
  });
}

async function withEnvironmentConfigurations(
  deps: FlagDefinitionDeps,
  appId: string,
  environmentId: string,
  rows: Awaited<ReturnType<FlagDefinitionDeps["repo"]["flags"]["listFlagPage"]>>,
  catalogs: Awaited<ReturnType<FlagDefinitionDeps["repo"]["flags"]["listVariantsForFlags"]>>,
) {
  const configs = await deps.repo.flags.listFlagConfigsByFlagIds(
    envScope(appId, environmentId),
    rows.map((row) => row.id),
  );
  const configByFlagId = new Map(configs.map((config) => [config.flagId, config]));
  return rows.map((row) => {
    const config = configByFlagId.get(row.id);
    if (!config) {
      throw new Error(
        `flag list: Flag ${row.id} has no Configuration in Environment ${environmentId}`,
      );
    }
    return flagWithConfigurationFrom(row, catalogs.get(row.id) ?? [], config);
  });
}

export async function getFlag(
  deps: FlagDefinitionDeps,
  { input, requestId, request }: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(input, "appId");
  const selector = pathParam(input, "flagId");
  // Path is id-only by default. Key lookup is an explicit ?by=key so a Flag key
  // that equals another Flag's canonical id can never collide on one segment
  // (SPL-236). Write routes stay id-only via loadWritableFlag.
  //
  // Read `by` from URLSearchParams (first value), not from the parsed query
  // record: queryToRecord last-wins on duplicates, while the Panel claim parser
  // first-wins — `?by=id&by=key` would otherwise mint by:"id" and resolve as key.
  const flag =
    flagLookupBy(request) === "key"
      ? await deps.repo.flags.getFlagByKey(appScope(appId), selector)
      : await deps.repo.flags.getFlag(appScope(appId), selector);
  if (!flag) return flagNotFound(requestId);
  return Response.json(await flagResponse(deps.repo, appId, flag));
}

/** Same source as `parseControlPanelOperation`: URLSearchParams first value. */
function flagLookupBy(request: Request): "id" | "key" {
  return new URL(request.url).searchParams.get("by") === "key" ? "key" : "id";
}

export async function updateFlag(
  deps: FlagDefinitionDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const loaded = await loadWritableFlag(deps, args);
  if (!loaded.ok) return loaded.response;

  const body = objectBody(args.input);
  const schema = await prepareSchemaPatch(deps, loaded.value, body, args.requestId);
  if (!schema.ok) return schema.response;

  const updated = await deps.repo.flags.updateFlag(loaded.value.scope, loaded.value.flag.id, {
    ...(body.name !== undefined ? { name: body.name as string } : {}),
    ...(body.description !== undefined ? { description: body.description as string } : {}),
    ...(schema.value !== undefined ? { schema: serializeSchema(schema.value) } : {}),
    updatedAt: nowIso(deps),
    updatedBy: args.principal.id,
  });
  if (!updated) return flagNotFound(args.requestId);
  return Response.json(await flagResponse(deps.repo, loaded.value.appId, updated));
}

async function prepareSchemaPatch(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Result<Record<string, unknown> | null | undefined>> {
  const schema = body.schema === undefined ? undefined : schemaFromBody(body.schema);
  if (schema === undefined) return ok(undefined);

  const existing = await deps.repo.flags.listVariants(loaded.scope, loaded.flag.id);
  const issues = [
    ...schemaDefinitionIssues(schema, ["body", "schema"]),
    ...variantSchemaIssues(
      schema,
      existing.map((variant) => ({
        name: variant.name,
        value: JSON.parse(variant.value) as Variant["value"],
        isDefault: variant.id === loaded.flag.defaultVariantId,
      })),
    ),
  ];
  return issues.length > 0 ? fail(validationErrors(requestId, issues)) : ok(schema);
}
