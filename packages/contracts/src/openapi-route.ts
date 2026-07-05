import { createRoute, type RouteConfig, z } from "@hono/zod-openapi";
import type { ErrorCode } from "./errors";
import {
  type AuthKind,
  defineRoute,
  type HttpMethod,
  type IdempotencyMode,
  type RateLimitClass,
  type RouteContract,
  type RouteOwner,
} from "./route-contract";

/**
 * One authored shape per HTTP endpoint that serves BOTH consumers from a single
 * source (ADR-0025): the @splitch/worker-runtime registrar (which reads the
 * RouteContract guard metadata + the runtime `input`/`output` Zod) and the
 * @hono/zod-openapi document / MCP tool derivation (which reads `operationId` +
 * the `request`/`responses` shapes). Authoring twice would let the two drift;
 * this helper derives both from one declaration.
 *
 * The runtime `input` schema is the `{ params, query, body }` object the
 * registrar's parseInput assembles and parses (see worker-runtime/parse-input.ts):
 * we compose it from the same params/query/body pieces the OpenAPI `request` uses,
 * so a Worker validates exactly what the OpenAPI doc advertises.
 */

/** The OpenAPI content-type every splitch route speaks. */
const JSON_CONTENT = "application/json";

/**
 * Request pieces for a route, in @hono/zod-openapi terms. `params`/`query` must
 * be Zod OBJECT schemas (the OpenAPI `RouteParameter` shape — one key per path or
 * query field); `body` is any Zod schema, wrapped in JSON content here.
 */
export interface ApiRouteRequest {
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodTypeAny;
}

export interface DefineApiRouteInput {
  /** Stable, explicit, UNIQUE `resource_operation` snake_case id (MCP tool name). */
  operationId: string;
  owner: RouteOwner;
  method: HttpMethod;
  /** Hono path; co-scope params are `:appId` / `:environmentId` (ADR-0027). */
  path: string;
  summary: string;
  request?: ApiRouteRequest;
  /** The 200 response body Zod schema. */
  response: z.ZodTypeAny;
  auth: AuthKind;
  scopes?: readonly string[];
  rateLimit: RateLimitClass;
  idempotency: IdempotencyMode;
  errors: readonly ErrorCode[];
}

/**
 * A route authored through {@link defineApiRoute}: it IS a RouteContract (so the
 * registrar mounts it unchanged) and additionally carries the `operationId`,
 * human `summary`, and the lazily-built `@hono/zod-openapi` `createRoute` config.
 */
export interface ApiRouteContract<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> extends RouteContract<Input, Output> {
  operationId: string;
  summary: string;
  /** The @hono/zod-openapi route definition derived from the same schemas. */
  openapi: RouteConfig;
}

/**
 * Build the runtime `input` schema the registrar parses: a `.strict()`-free
 * object keyed by the request parts present, matching parseInput's RawInput
 * (`{ params, query, headers, body }`). Absent parts are simply omitted so the
 * route only validates what it declares.
 */
function runtimeInput(request: ApiRouteRequest | undefined): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (request?.params) {
    shape.params = request.params;
  }
  if (request?.query) {
    shape.query = request.query;
  }
  if (request?.body) {
    shape.body = request.body;
  }
  return z.object(shape);
}

/** Build the @hono/zod-openapi route config from the authored pieces. */
function openapiConfig(input: DefineApiRouteInput): RouteConfig {
  const request: NonNullable<RouteConfig["request"]> = {};
  if (input.request?.params) {
    request.params = input.request.params;
  }
  if (input.request?.query) {
    request.query = input.request.query;
  }
  if (input.request?.body) {
    request.body = {
      content: { [JSON_CONTENT]: { schema: input.request.body } },
    };
  }

  return {
    method: input.method.toLowerCase() as Lowercase<HttpMethod>,
    path: input.path,
    operationId: input.operationId,
    summary: input.summary,
    request,
    responses: {
      200: {
        description: input.summary,
        content: { [JSON_CONTENT]: { schema: input.response } },
      },
    },
  };
}

/**
 * Author one route once; get a registrar-mountable RouteContract and a derived
 * OpenAPI/MCP definition. Policy defaults (no scopes) match the safest baseline;
 * a route opts into stricter policy explicitly.
 */
export function defineApiRoute<const Op extends string>(
  input: DefineApiRouteInput & { operationId: Op },
): ApiRouteContract & { operationId: Op } {
  const contract = defineRoute({
    id: input.operationId,
    owner: input.owner,
    method: input.method,
    path: input.path,
    input: runtimeInput(input.request),
    output: input.response,
    auth: input.auth,
    scopes: input.scopes ?? [],
    rateLimit: input.rateLimit,
    idempotency: input.idempotency,
    errors: input.errors,
  });

  return {
    ...contract,
    operationId: input.operationId,
    summary: input.summary,
    openapi: createRoute(openapiConfig(input)),
  };
}

export { z };
