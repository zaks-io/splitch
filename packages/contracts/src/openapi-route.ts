import { type RouteConfig, z } from "@hono/zod-openapi";
import { errorStatusByCode } from "./error-status";
import { type ErrorCode, ErrorResponseSchema } from "./errors";
import { buildOpenApiRoute } from "./openapi-route-config";
import { derivedErrors, selectorAwareRequest } from "./openapi-route-request";
import type {
  HttpMethod,
  IdempotencyMode,
  RateLimitClass,
  RawBodyByteLimit,
  RouteAuthorization,
  RouteContract,
  RouteOwner,
} from "./route-contract";
import type { RouteEffects } from "./route-effects";

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
  headers?: z.ZodObject;
  body?: z.ZodTypeAny;
  /**
   * When set, the registrar validates this schema instead of `body`. OpenAPI
   * still documents `body`. Used when the handler classifies protocol-specific
   * parse failures (for example OFREP PARSE_ERROR / INVALID_CONTEXT).
   */
  runtimeBody?: z.ZodTypeAny;
}

type RouteExposure = "public" | "mcp-binding" | "public-bearer";

interface ApiRouteInputFields {
  /** Stable, explicit, UNIQUE `resource_operation` snake_case id (MCP tool name). */
  operationId: string;
  owner: RouteOwner;
  method: HttpMethod;
  /** Hono path; co-scope params are `:appId` / `:environmentId` (ADR-0027). */
  path: string;
  summary: string;
  /**
   * Which HTTP door may mount this route. Defaults to the public credential
   * surface. `public-bearer` is public-door ONLY: never mounted on a service
   * binding (MCP or panel), for operations a delegated caller must never reach.
   */
  exposure?: RouteExposure;
  request?: ApiRouteRequest;
  /** The 200 response body Zod schema. */
  response: z.ZodTypeAny;
  /**
   * When true, OpenAPI also advertises HTTP 304 with an empty body
   * (If-None-Match revalidation).
   */
  notModifiedResponse?: boolean;
  /**
   * Route-specific error response schemas keyed by HTTP status. When present
   * for a status, replaces the auto-built ErrorResponseSchema union for that
   * status so protocol-shaped errors (OFREP, etc.) match the wire.
   */
  errorResponseSchemas?: Readonly<Record<number, z.ZodTypeAny>>;
  scopes?: readonly string[];
  rateLimit: RateLimitClass;
  idempotency: IdempotencyMode;
  /** Commits in this domain append an App audit fact with action = operationId. */
  audit?: "app";
  temporaryEnvironment?: true;
  rawBodyByteLimit?: RawBodyByteLimit;
  errors: readonly ErrorCode[];
  /** Audited effects; never inferred from `method`. */
  effects: RouteEffects;
}

export type DefineApiRouteInput = ApiRouteInputFields & RouteAuthorization;

/**
 * A route authored through {@link defineApiRoute}: it IS a RouteContract (so the
 * registrar mounts it unchanged) and additionally carries the `operationId`,
 * human `summary`, and the lazily-built `@hono/zod-openapi` `createRoute` config.
 */
export type ApiRouteContract<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> = RouteContract<Input, Output> & {
  operationId: string;
  summary: string;
  exposure: RouteExposure;
  effects: RouteEffects;
  /** The @hono/zod-openapi route definition derived from the same schemas. */
  openapi: RouteConfig;
};

/**
 * The Zod schema behind a route's JSON media-type entry (request body or
 * response), narrowing out the `ReferenceObject` (`$ref`) variant that
 * `@asteasolutions/zod-to-openapi` 9.x's `ZodContentObject` allows alongside
 * `ZodMediaTypeObject` (openapi-registry.d.ts: `ZodContentObject = Partial<
 * Record<ZodMediaType, ZodMediaTypeObject | ReferenceObject>>` — a `$ref`
 * media-type entry is an OAS 3.2 addition; see the `@asteasolutions/zod-to-openapi`
 * changelog). Every splitch route always authors a live Zod schema, never a
 * `$ref` media type, so this narrows structurally on the `"schema"` key rather
 * than casting the union away.
 */
export function jsonMediaTypeSchema(
  content: Partial<Record<string, { schema?: unknown } | { $ref: string }>> | undefined,
): z.ZodTypeAny | undefined {
  const entry = content?.[JSON_CONTENT];
  if (!entry || !("schema" in entry)) {
    return undefined;
  }
  return entry.schema as z.ZodTypeAny | undefined;
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
  if (request?.headers) {
    // Omitting the header group must accept the same requests as empty headers.
    shape.headers = request.headers.safeParse({}).success
      ? request.headers.optional()
      : request.headers;
  }
  const body = request?.runtimeBody ?? request?.body;
  if (body) {
    shape.body = body;
  }
  return z.object(shape);
}

/** OpenAPI `{param}` paths so @hono/zod-openapi + `hc` infer nested client routes. */
export function honoPathToOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

/** Type-level Hono `:param` → OpenAPI `{param}` conversion for literal route paths. */
export type HonoToOpenApiPath<S extends string> =
  S extends `${infer Head}/:${infer Name}/${infer Tail}`
    ? `${Head}/{${Name}}/${HonoToOpenApiPath<Tail>}`
    : S extends `${infer Head}/:${infer Name}`
      ? `${Head}/{${Name}}`
      : S;

let errorSchemaByCode: Map<ErrorCode, z.ZodTypeAny> | undefined;

/** The ErrorResponse Zod member for one ErrorCode (OpenAPI / custom unions). */
export function errorResponseSchemaFor(code: ErrorCode): z.ZodTypeAny {
  errorSchemaByCode ??= new Map(
    ErrorResponseSchema.options.map((schema) => [schema.shape.code.value, schema]),
  );
  const schema = errorSchemaByCode.get(code);
  if (!schema) {
    throw new Error(`openapi-route: ErrorCode "${code}" has no ErrorResponse schema`);
  }
  return schema;
}

export function defineApiRoute<const Input extends DefineApiRouteInput>(
  input: Input,
): RouteContract & {
  operationId: string;
  summary: string;
  exposure: RouteExposure;
  effects: RouteEffects;
  openapi: ReturnType<typeof buildOpenApiRoute<Input>>;
  audit?: "app";
} {
  const errors = derivedErrors(input);
  for (const code of errors) {
    if (errorStatusByCode[code] === undefined) {
      throw new Error(`openapi-route: ErrorCode "${code}" has no mapped HTTP status`);
    }
  }
  const authorization: RouteAuthorization =
    input.auth === "control-plane-token"
      ? { auth: input.auth, permission: input.permission }
      : { auth: input.auth };
  let selectedRequest: ReturnType<typeof selectorAwareRequest>;
  let requestInitialized = false;
  function request() {
    if (!requestInitialized) {
      selectedRequest = selectorAwareRequest(input);
      requestInitialized = true;
    }
    return selectedRequest;
  }
  let runtimeSchema: z.ZodTypeAny | undefined;
  let openapi: ReturnType<typeof buildOpenApiRoute<Input>> | undefined;
  return {
    id: input.operationId,
    owner: input.owner,
    method: input.method,
    path: input.path,
    get input() {
      runtimeSchema ??= runtimeInput(request());
      return runtimeSchema;
    },
    output: input.response,
    ...authorization,
    scopes: input.scopes ?? [],
    rateLimit: input.rateLimit,
    idempotency: input.idempotency,
    ...(input.temporaryEnvironment ? { temporaryEnvironment: input.temporaryEnvironment } : {}),
    rawBodyByteLimit: input.rawBodyByteLimit,
    errors,
    operationId: input.operationId,
    summary: input.summary,
    exposure: input.exposure ?? "public",
    effects: input.effects,
    ...(input.audit ? { audit: input.audit } : {}),
    get openapi() {
      openapi ??= buildOpenApiRoute(input, request(), errors);
      return openapi;
    },
  };
}

export { z };
