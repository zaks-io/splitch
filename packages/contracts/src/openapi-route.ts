import { createRoute, type RouteConfig, z } from "@hono/zod-openapi";
import { errorStatusByCode } from "./error-status";
import { type ErrorCode, ErrorResponseSchema } from "./errors";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_KEY_SHAPE_MESSAGE,
} from "./persisted-field-limits";
import {
  type AuthKind,
  defineRoute,
  type HttpMethod,
  type IdempotencyMode,
  type RateLimitClass,
  type RawBodyByteLimit,
  type RouteContract,
  type RouteOwner,
} from "./route-contract";
import { CanonicalEnvironmentSelectorQuerySchema } from "./routes/route-shapes-params";

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
const IDEMPOTENCY_HEADER = "Idempotency-Key";

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
  /** Which HTTP door may mount this route. Defaults to the public credential surface. */
  exposure?: "public" | "mcp-binding";
  request?: ApiRouteRequest;
  /** The 200 response body Zod schema. */
  response: z.ZodTypeAny;
  /**
   * When true, OpenAPI also advertises HTTP 304 with an empty body
   * (If-None-Match revalidation).
   */
  notModifiedResponse?: boolean;
  auth: AuthKind;
  scopes?: readonly string[];
  rateLimit: RateLimitClass;
  idempotency: IdempotencyMode;
  rawBodyByteLimit?: RawBodyByteLimit;
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
  exposure: "public" | "mcp-binding";
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

/** OpenAPI `{param}` paths so @hono/zod-openapi + `hc` infer nested client routes. */
export function honoPathToOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

/** Type-level Hono `:param` → OpenAPI `{param}` conversion for literal route paths. */
type HonoToOpenApiPath<S extends string> = S extends `${infer Head}/:${infer Name}/${infer Tail}`
  ? `${Head}/{${Name}}/${HonoToOpenApiPath<Tail>}`
  : S extends `${infer Head}/:${infer Name}`
    ? `${Head}/{${Name}}`
    : S;

function buildOpenApiRequestConfig(request: ApiRouteRequest | undefined) {
  if (!request) {
    return undefined;
  }
  if (request.params) {
    return {
      params: request.params,
      ...(request.query ? { query: request.query } : {}),
      ...(request.body ? { body: { content: { [JSON_CONTENT]: { schema: request.body } } } } : {}),
    };
  }
  if (request.query) {
    return { query: request.query };
  }
  if (request.body) {
    return { body: { content: { [JSON_CONTENT]: { schema: request.body } } } };
  }
  return undefined;
}

function idempotencyHeader(mode: IdempotencyMode) {
  if (mode === "none") return undefined;
  return z.object({
    [IDEMPOTENCY_HEADER]: z
      .string()
      .min(1)
      .max(IDEMPOTENCY_KEY_MAX_LENGTH)
      .regex(IDEMPOTENCY_KEY_PATTERN, IDEMPOTENCY_KEY_SHAPE_MESSAGE)
      .openapi({
        param: { name: IDEMPOTENCY_HEADER, in: "header", required: mode === "required" },
        example: "logical-evaluation-123",
      }),
  });
}

const errorSchemaByCode = new Map<ErrorCode, z.ZodTypeAny>(
  ErrorResponseSchema.options.map((schema) => [schema.shape.code.value, schema]),
);

function buildOpenApiErrorResponses(codes: readonly ErrorCode[]) {
  const schemasByStatus = new Map<number, z.ZodTypeAny[]>();
  for (const code of codes) {
    const status = errorStatusByCode[code];
    if (status === undefined) {
      throw new Error(`openapi-route: ErrorCode "${code}" has no mapped HTTP status`);
    }
    const schema = errorSchemaByCode.get(code);
    if (!schema) {
      throw new Error(`openapi-route: ErrorCode "${code}" has no ErrorResponse schema`);
    }
    schemasByStatus.set(status, [...(schemasByStatus.get(status) ?? []), schema]);
  }

  return Object.fromEntries(
    [...schemasByStatus].map(([status, schemas]) => [
      status,
      {
        description: "Error response.",
        content: {
          [JSON_CONTENT]: { schema: schemas.length === 1 ? schemas[0] : z.union(schemas) },
        },
      },
    ]),
  );
}

export function defineApiRoute<const Input extends DefineApiRouteInput>(input: Input) {
  const errors = selectorAwareErrors(input);
  const request = selectorAwareRequest(input);
  const contract = defineRoute({
    id: input.operationId,
    owner: input.owner,
    method: input.method,
    path: input.path,
    input: runtimeInput(request),
    output: input.response,
    auth: input.auth,
    scopes: input.scopes ?? [],
    rateLimit: input.rateLimit,
    idempotency: input.idempotency,
    rawBodyByteLimit: input.rawBodyByteLimit,
    errors,
  });

  return {
    ...contract,
    operationId: input.operationId,
    summary: input.summary,
    exposure: input.exposure ?? "public",
    openapi: createRoute({
      method: input.method.toLowerCase() as Lowercase<HttpMethod>,
      path: honoPathToOpenApiPath(input.path) as HonoToOpenApiPath<Input["path"]>,
      operationId: input.operationId,
      summary: input.summary,
      request: {
        ...(buildOpenApiRequestConfig(request) ?? {}),
        ...(idempotencyHeader(input.idempotency)
          ? { headers: idempotencyHeader(input.idempotency) }
          : {}),
      },
      responses: {
        ...buildOpenApiErrorResponses(errors),
        200: {
          description: input.summary,
          content: { [JSON_CONTENT]: { schema: input.response } },
        },
        ...(input.notModifiedResponse
          ? {
              304: {
                description: "Not Modified — cached response is still current.",
              },
            }
          : {}),
      },
    } as const),
  };
}

/**
 * Environment ambiguity must expose a declared escape hatch on every affected route.
 * This deliberately gives all 26 control-plane-token routes with `:environmentId` or
 * `:targetEnvironmentId` a strict query contract: unknown query params now return
 * 400 VALIDATION_ERROR where routes without a query schema previously ignored them.
 * That fail-loud contract change is intentional under ADR-0036.
 */
function selectorAwareRequest(input: DefineApiRouteInput): ApiRouteRequest | undefined {
  if (
    input.auth !== "control-plane-token" ||
    (!input.path.includes(":environmentId") && !input.path.includes(":targetEnvironmentId"))
  ) {
    return input.request;
  }
  const request = input.request ?? {};
  const query = request.query;
  if (query?.shape.by) return request;
  return {
    ...request,
    query: query
      ? query.extend(CanonicalEnvironmentSelectorQuerySchema.shape)
      : CanonicalEnvironmentSelectorQuerySchema,
  };
}

/** Resolver errors are derived from App and nested selector axes exposed by the route. */
function selectorAwareErrors(input: DefineApiRouteInput): readonly ErrorCode[] {
  if (input.auth !== "control-plane-token" || !input.path.includes(":appId")) return input.errors;
  const errors = new Set(input.errors);
  errors.add("APP_NOT_FOUND");
  errors.add("SELECTOR_AMBIGUOUS");
  if (input.path.includes(":flagId")) errors.add("FLAG_NOT_FOUND");
  return [...errors];
}

export { z };
