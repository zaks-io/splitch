import { OpenAPIHono } from "@hono/zod-openapi";
import { routeRegistry } from "./route-registry";

/**
 * On-demand OpenAPI 3.1 document emission from THE single route registry
 * (ADR-0025). Nothing is written to disk: the document is built in-memory when a
 * consumer asks for it (the Control Plane Worker serving `/.well-known/openapi.json`,
 * the contracts test suite). Committing a generated openapi.json would invert the
 * source of truth and let it drift from the Zod routes — the registry IS the truth.
 *
 * Every registered route carries a `route.openapi` config (built by defineApiRoute
 * via createRoute); we register all of them on a throwaway OpenAPIHono and let
 * @hono/zod-openapi walk the Zod schemas into the document. The handler is a stub:
 * we never serve from this app, we only ask it for the document, so the handler is
 * never invoked.
 */

export interface OpenApiDocumentInfo {
  title: string;
  version: string;
}

const DEFAULT_INFO: OpenApiDocumentInfo = {
  title: "splitch control-plane API",
  version: "0.0.0",
};

/** Handler the emitter never calls — the app exists only to emit, not to serve. */
function unusedHandler(): Response {
  throw new Error("openapi-document: emit-only app must never handle a request");
}

/**
 * Build the OpenAPI 3.1 document for the whole registry, on demand. Returns the
 * plain document object (an `OpenAPIObject`) so a caller can `JSON.stringify` it
 * or assert over it; this function does NOT serialize or persist it.
 */
export function buildOpenApiDocument(
  info: OpenApiDocumentInfo = DEFAULT_INFO,
): ReturnType<OpenAPIHono["getOpenAPI31Document"]> {
  const app = new OpenAPIHono();
  for (const route of routeRegistry) {
    app.openapi(route.openapi, unusedHandler);
  }
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: info.title, version: info.version },
  });
}
