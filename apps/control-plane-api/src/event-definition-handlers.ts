import {
  CURRENT_KV_SCHEMA_VERSION,
  type EventDefinition,
  type EventDefinitionVersion,
  eventDefinitionConfigKey,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import type { HandlerArgs, Registrar } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { appNotFound, nowIso } from "./app-environment-model";
import { canonicalHash } from "./approval-canonical";
import { randomHex } from "./credential-cache";
import { commitEventDefinitionPublication } from "./event-definition-publication";
import { validationError } from "./flag-definition-errors";
import { objectBody, pathParam } from "./handler-input";
import { requireWritableApp } from "./metric-segment-shared";
import { controlPlaneRoute } from "./routes";

export interface EventDefinitionDeps {
  readonly repo: Repository;
  readonly eventDefinitionStore?: KVNamespace;
  readonly nowIso?: () => string;
}

export function registerEventDefinitionRoutes(
  app: Hono,
  registrar: Registrar,
  deps: EventDefinitionDeps,
): void {
  const handlers = makeEventDefinitionHandlers(deps);
  registrar.mount(app, controlPlaneRoute("event_definitions_list"), handlers.list);
  registrar.mount(app, controlPlaneRoute("event_definitions_create"), handlers.create);
  registrar.mount(app, controlPlaneRoute("event_definitions_get"), handlers.get);
  registrar.mount(app, controlPlaneRoute("event_definitions_update"), handlers.update);
  registrar.mount(app, controlPlaneRoute("event_definition_versions_create"), handlers.publish);
  registrar.mount(app, controlPlaneRoute("event_definition_versions_list"), handlers.listVersions);
  registrar.mount(app, controlPlaneRoute("event_definition_versions_get"), handlers.getVersion);
}

function makeEventDefinitionHandlers(deps: EventDefinitionDeps) {
  return {
    list: (args: HandlerArgs<unknown>) => list(deps, args),
    create: (args: HandlerArgs<unknown>) => create(deps, args),
    get: (args: HandlerArgs<unknown>) => get(deps, args),
    update: (args: HandlerArgs<unknown>) => update(deps, args),
    publish: (args: HandlerArgs<unknown>) => publish(deps, args),
    listVersions: (args: HandlerArgs<unknown>) => listVersions(deps, args),
    getVersion: (args: HandlerArgs<unknown>) => getVersion(deps, args),
  };
}

async function list(deps: EventDefinitionDeps, args: HandlerArgs<unknown>): Promise<Response> {
  const appId = pathParam(args.input, "appId");
  if (!(await deps.repo.identity.getApp(appId))) return appNotFound(args.requestId);
  const rows = await deps.repo.eventDefinitions.definitions.findMany(appScope(appId));
  return Response.json({ items: rows.map(definitionResponse) });
}

async function create(deps: EventDefinitionDeps, args: HandlerArgs<unknown>): Promise<Response> {
  const appId = pathParam(args.input, "appId");
  const denied = await requireWritableApp(deps, appId, args.principal, args.requestId);
  if (denied) return denied;
  const body = objectBody(args.input);
  if (await deps.repo.eventDefinitions.findByName(appScope(appId), body.name as string)) {
    return validationError(args.requestId, [
      ["body", "name"],
      "Event Definition name already exists",
    ]);
  }
  const now = nowIso(deps);
  const row = await deps.repo.eventDefinitions.definitions.insert(appScope(appId), {
    id: `event_definition_${randomHex(12)}`,
    appId,
    name: body.name as string,
    family: body.family as string,
    displayName: body.displayName as string,
    ...(body.description === undefined ? {} : { description: body.description as string }),
    currentPublishedVersionId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: args.principal.id,
    updatedBy: args.principal.id,
  });
  return Response.json(definitionResponse(row));
}

async function get(deps: EventDefinitionDeps, args: HandlerArgs<unknown>): Promise<Response> {
  const definition = await definitionFromPath(deps, args.input);
  if (!definition) return notFound(args.requestId);
  const versions = await deps.repo.eventDefinitions.listVersions(
    appScope(definition.appId),
    definition.id,
  );
  return Response.json({
    ...definitionResponse(definition),
    versions: versions.map(versionResponse),
  });
}

async function update(deps: EventDefinitionDeps, args: HandlerArgs<unknown>): Promise<Response> {
  const appId = pathParam(args.input, "appId");
  const denied = await requireWritableApp(deps, appId, args.principal, args.requestId);
  if (denied) return denied;
  const definition = await definitionFromPath(deps, args.input);
  if (!definition) return notFound(args.requestId);
  const body = objectBody(args.input);
  const updated = await deps.repo.eventDefinitions.update(appScope(appId), definition.id, {
    ...(body.displayName === undefined ? {} : { displayName: body.displayName as string }),
    ...(body.description === undefined ? {} : { description: body.description as string }),
    updatedAt: nowIso(deps),
    updatedBy: args.principal.id,
  });
  if (!updated) throw new Error("Event Definition update selected no row");
  return Response.json(definitionResponse(updated));
}

async function publish(deps: EventDefinitionDeps, args: HandlerArgs<unknown>): Promise<Response> {
  const appId = pathParam(args.input, "appId");
  const denied = await requireWritableApp(deps, appId, args.principal, args.requestId);
  if (denied) return denied;
  const definition = await definitionFromPath(deps, args.input);
  if (!definition) return notFound(args.requestId);
  if (!deps.eventDefinitionStore) return unavailable(args.requestId);
  const body = objectBody(args.input);
  if (definition.family === "metric" && body.entityType === null) {
    return validationError(args.requestId, [
      ["body", "entityType"],
      "A Metric Event Definition Version needs an Entity type",
    ]);
  }
  const schema = { entityType: body.entityType, fields: body.fields, dimensions: body.dimensions };
  const now = nowIso(deps);
  const scope = appScope(appId);
  const versionNumber = await deps.repo.eventDefinitions.nextVersion(scope, definition.id);
  if (versionNumber === null) return notFound(args.requestId);
  const input = {
    id: `event_definition_version_${randomHex(12)}`,
    appId,
    eventDefinitionId: definition.id,
    version: versionNumber,
    schemaHash: await canonicalHash(schema),
    entityType: body.entityType as string | null,
    fields: JSON.stringify(body.fields),
    dimensions: JSON.stringify(body.dimensions),
    publishedAt: now,
    publishedBy: args.principal.id,
  };
  const version: EventDefinitionVersion = {
    id: input.id,
    eventDefinitionId: input.eventDefinitionId,
    version: input.version,
    schemaHash: input.schemaHash,
    entityType: input.entityType,
    fields: body.fields as EventDefinitionVersion["fields"],
    dimensions: body.dimensions as EventDefinitionVersion["dimensions"],
    publishedAt: input.publishedAt,
  };
  const current = {
    ...definitionResponse(definition),
    currentPublishedVersionId: input.id,
    updatedAt: now,
  };
  const row = await commitEventDefinitionPublication({
    store: deps.eventDefinitionStore,
    configKey: eventDefinitionConfigKey(appId, definition.name),
    config: JSON.stringify({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: { eventDefinition: current, version },
    }),
    repo: deps.repo,
    scope,
    input,
    updatedAt: now,
    updatedBy: args.principal.id,
    appId,
    eventDefinitionId: definition.id,
  });
  return Response.json(versionResponse(row));
}

async function listVersions(
  deps: EventDefinitionDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const definition = await definitionFromPath(deps, args.input);
  if (!definition) return notFound(args.requestId);
  const rows = await deps.repo.eventDefinitions.listVersions(
    appScope(definition.appId),
    definition.id,
  );
  return Response.json({ items: rows.map(versionResponse) });
}

async function getVersion(
  deps: EventDefinitionDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const appId = pathParam(args.input, "appId");
  const eventDefinitionId = pathParam(args.input, "eventDefinitionId");
  const row = await deps.repo.eventDefinitions.getVersion(
    appScope(appId),
    eventDefinitionId,
    pathParam(args.input, "versionId"),
  );
  if (!row) return versionNotFound(args.requestId);
  return Response.json(versionResponse(row));
}

function definitionFromPath(deps: EventDefinitionDeps, input: unknown) {
  return deps.repo.eventDefinitions.get(
    appScope(pathParam(input, "appId")),
    pathParam(input, "eventDefinitionId"),
  );
}

type DefinitionRow =
  Awaited<ReturnType<Repository["eventDefinitions"]["get"]>> extends infer T
    ? NonNullable<T>
    : never;
type VersionRow =
  Awaited<ReturnType<Repository["eventDefinitions"]["getVersion"]>> extends infer T
    ? NonNullable<T>
    : never;

function definitionResponse(row: DefinitionRow): EventDefinition {
  return {
    id: row.id,
    appId: row.appId,
    name: row.name,
    family: row.family as EventDefinition["family"],
    displayName: row.displayName,
    ...(row.description === null ? {} : { description: row.description }),
    currentPublishedVersionId: row.currentPublishedVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function versionResponse(row: VersionRow): EventDefinitionVersion {
  return {
    id: row.id,
    eventDefinitionId: row.eventDefinitionId,
    version: row.version,
    schemaHash: row.schemaHash,
    entityType: row.entityType,
    fields: JSON.parse(row.fields),
    dimensions: JSON.parse(row.dimensions),
    publishedAt: row.publishedAt,
  };
}

function notFound(requestId: string): Response {
  return renderError(
    { code: "EVENT_DEFINITION_NOT_FOUND", message: "Event Definition not found", details: {} },
    { requestId },
  );
}

function versionNotFound(requestId: string): Response {
  return renderError(
    {
      code: "EVENT_DEFINITION_VERSION_NOT_FOUND",
      message: "Event Definition Version not found",
      details: {},
    },
    { requestId },
  );
}

function unavailable(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "Event Definition config store is unavailable",
      details: { retryAfterMs: 1000 },
    },
    { requestId },
  );
}
