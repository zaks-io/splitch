import { mediaTypeOf } from "@splitch/bounded-body";
import type { ErrorResponse, RouteContract } from "@splitch/contracts";

const JSON_MEDIA_TYPE = "application/json";

/** A declared non-JSON media type is rejected before any body byte is read. */
export function mutatingJsonMediaTypeError(
  contract: Pick<RouteContract, "method">,
  request: Request,
): ErrorResponse | null {
  if (contract.method === "GET" || request.body === null) {
    return null;
  }
  const receivedMediaType = mediaTypeOf(request.headers.get("content-type"));
  if (receivedMediaType === null || receivedMediaType === JSON_MEDIA_TYPE) {
    return null;
  }
  return unsupportedMediaType(receivedMediaType);
}

/**
 * The Cloudflare edge hands a body-less DELETE or POST to the Worker as an
 * empty, non-null stream, so a mutation without a Content-Type is only rejected
 * once the bounded body read proves it carries bytes.
 */
export function unlabeledBodyError(
  contract: Pick<RouteContract, "method">,
  request: Request,
): ErrorResponse | undefined {
  if (contract.method === "GET" || mediaTypeOf(request.headers.get("content-type")) !== null) {
    return undefined;
  }
  return unsupportedMediaType(null);
}

function unsupportedMediaType(receivedMediaType: string | null): ErrorResponse {
  return {
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: "request body must use application/json",
    details: {
      receivedMediaType,
      supportedMediaTypes: [JSON_MEDIA_TYPE],
    },
  };
}
