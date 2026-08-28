import { z } from "@hono/zod-openapi";
import {
  EventDefinitionDetailSchema,
  EventDefinitionListResponseSchema,
  EventDefinitionSchema,
  EventDefinitionVersionListResponseSchema,
  EventDefinitionVersionSchema,
} from "../event-definition";
import {
  CreateEventDefinitionRequestSchema,
  PatchEventDefinitionRequestSchema,
  PublishEventDefinitionVersionRequestSchema,
} from "../event-definition-write";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { AppParams } from "./route-shapes";

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;
const EventDefinitionParams = AppParams.extend({ eventDefinitionId: z.string() });
const EventDefinitionVersionParams = EventDefinitionParams.extend({ versionId: z.string() });

export const eventDefinitionRoutes = [
  defineApiRoute({
    operationId: "event_definitions_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/event-definitions",
    summary: "List Event Definitions in an App.",
    request: { params: AppParams },
    response: EventDefinitionListResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "event_definitions_create",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/event-definitions",
    summary: "Create an App-level Event Definition.",
    request: { params: AppParams, body: CreateEventDefinitionRequestSchema },
    response: EventDefinitionSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "optional",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "event_definitions_get",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/event-definitions/:eventDefinitionId",
    summary: "Get an Event Definition and its immutable published Versions.",
    request: { params: EventDefinitionParams },
    response: EventDefinitionDetailSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["EVENT_DEFINITION_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "event_definitions_update",
    owner: OWNER,
    method: "PATCH",
    path: "/apps/:appId/event-definitions/:eventDefinitionId",
    summary: "Update Event Definition display metadata.",
    request: { params: EventDefinitionParams, body: PatchEventDefinitionRequestSchema },
    response: EventDefinitionSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["EVENT_DEFINITION_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "event_definition_versions_create",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/event-definitions/:eventDefinitionId/versions",
    summary: "Publish the next immutable Event Definition Version.",
    request: { params: EventDefinitionParams, body: PublishEventDefinitionVersionRequestSchema },
    response: EventDefinitionVersionSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "optional",
    errors: [
      "EVENT_DEFINITION_NOT_FOUND",
      "EVENT_DEFINITION_IMMUTABLE",
      "FORBIDDEN",
      "VALIDATION_ERROR",
      "SERVICE_UNAVAILABLE",
    ],
  }),
  defineApiRoute({
    operationId: "event_definition_versions_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/event-definitions/:eventDefinitionId/versions",
    summary: "List immutable Event Definition Versions.",
    request: { params: EventDefinitionParams },
    response: EventDefinitionVersionListResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["EVENT_DEFINITION_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "event_definition_versions_get",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/event-definitions/:eventDefinitionId/versions/:versionId",
    summary: "Get one immutable Event Definition Version.",
    request: { params: EventDefinitionVersionParams },
    response: EventDefinitionVersionSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["EVENT_DEFINITION_VERSION_NOT_FOUND", "FORBIDDEN"],
  }),
] as const satisfies readonly ApiRouteContract[];
