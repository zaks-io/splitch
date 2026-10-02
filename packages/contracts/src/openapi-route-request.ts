import type { z } from "zod";
import type { ErrorCode } from "./errors";
import type { AuthKind, HttpMethod } from "./route-contract";
import { CanonicalEnvironmentSelectorQuerySchema } from "./routes/route-shapes-params";

interface RouteRequest {
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodTypeAny;
}

/**
 * Environment ambiguity must expose a declared escape hatch on every affected route.
 * This deliberately gives all 26 control-plane-token routes with `:environmentId` or
 * `:targetEnvironmentId` a strict query contract: unknown query params now return
 * 400 VALIDATION_ERROR where routes without a query schema previously ignored them.
 * That fail-loud contract change is intentional under ADR-0036.
 */
export function selectorAwareRequest(input: {
  auth: AuthKind;
  path: string;
  request?: RouteRequest;
}): RouteRequest | undefined {
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
export function derivedErrors(input: {
  method: HttpMethod;
  auth: AuthKind;
  path: string;
  errors: readonly ErrorCode[];
}): readonly ErrorCode[] {
  const errors = new Set(input.errors);
  if (input.method !== "GET") errors.add("UNSUPPORTED_MEDIA_TYPE");
  if (input.auth === "control-plane-token" && input.path.includes(":appId")) {
    errors.add("APP_NOT_FOUND");
    errors.add("SELECTOR_AMBIGUOUS");
    if (input.path.includes(":flagId")) errors.add("FLAG_NOT_FOUND");
  }
  return [...errors];
}
