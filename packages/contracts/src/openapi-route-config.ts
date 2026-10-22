import { createRoute, z } from "@hono/zod-openapi";
import { errorStatusByCode } from "./error-status";
import type { ErrorCode } from "./errors";
import {
  type ApiRouteRequest,
  type DefineApiRouteInput,
  errorResponseSchemaFor,
  type HonoToOpenApiPath,
  honoPathToOpenApiPath,
} from "./openapi-route";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_KEY_SHAPE_MESSAGE,
} from "./persisted-field-limits";
import type { HttpMethod, IdempotencyMode } from "./route-contract";

const JSON_CONTENT = "application/json";
const IDEMPOTENCY_HEADER = "Idempotency-Key";

function buildOpenApiRequestConfig(request: ApiRouteRequest | undefined) {
  if (!request) return undefined;
  const parts = buildOpenApiRequestParts(request);
  return request.headers ? { ...parts, headers: request.headers } : parts;
}

function buildOpenApiRequestParts(request: ApiRouteRequest) {
  if (request.params) {
    return {
      params: request.params,
      ...(request.query ? { query: request.query } : {}),
      ...(request.body ? { body: { content: { [JSON_CONTENT]: { schema: request.body } } } } : {}),
    };
  }
  if (request.query) return { query: request.query };
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

function buildOpenApiErrorResponses(
  codes: readonly ErrorCode[],
  overrides: Readonly<Record<number, z.ZodTypeAny>> | undefined,
) {
  const schemasByStatus = new Map<number, z.ZodTypeAny[]>();
  for (const code of codes) {
    const status = errorStatusByCode[code];
    if (status === undefined) {
      throw new Error(`openapi-route: ErrorCode "${code}" has no mapped HTTP status`);
    }
    if (overrides?.[status] !== undefined) {
      // Route-specific schema owns this status; skip ErrorResponse members.
      continue;
    }
    schemasByStatus.set(status, [
      ...(schemasByStatus.get(status) ?? []),
      errorResponseSchemaFor(code),
    ]);
  }

  const built = Object.fromEntries(
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

  if (overrides === undefined) return built;

  return {
    ...built,
    ...Object.fromEntries(
      Object.entries(overrides).map(([status, schema]) => [
        status,
        {
          description: "Error response.",
          content: { [JSON_CONTENT]: { schema } },
        },
      ]),
    ),
  };
}

/** Built only when OpenAPI or MCP discovery reads a route's documentation. */
export function buildOpenApiRoute<const Input extends DefineApiRouteInput>(
  input: Input,
  request: ApiRouteRequest | undefined,
  errors: readonly ErrorCode[],
) {
  return createRoute({
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
      ...buildOpenApiErrorResponses(errors, input.errorResponseSchemas),
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
  } as const);
}
