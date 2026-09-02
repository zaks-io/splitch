import { OpenAPIHono } from "@hono/zod-openapi";
import {
  FullCommitShaSchema,
  isHostedPlatformTarget,
  requirePlatformTarget,
} from "./health-response";
import { publicSurfaceFor } from "./route-contract";
import { routeRegistry } from "./route-registry";

/**
 * On-demand OpenAPI 3.1 document emission from THE single route registry
 * (ADR-0025). Nothing is written to disk: the document is built in-memory when a
 * consumer asks for it (the Control Plane Worker serving `/.well-known/openapi.json`,
 * the contracts test suite). Committing a generated openapi.json would invert the
 * source of truth and let it drift from the Zod routes — the registry IS the truth.
 *
 * Every publicly surfaced route carries a `route.openapi` config (built by
 * defineApiRoute via createRoute); we register those routes on a throwaway
 * OpenAPIHono and let @hono/zod-openapi walk the Zod schemas into the document.
 * Binding-only routes have no public address, so publishing them here would
 * expose an internal contract through public discovery. The handler is a stub:
 * we never serve from this app, we only ask it for the document, so the handler
 * is never invoked.
 */

export interface OpenApiDocumentInfo {
  title?: string;
  version: string;
}

const DEFAULT_TITLE = "splitch control-plane API";

/**
 * `info.version` is the only handle a consumer has for telling two emitted
 * documents apart, so it carries the deployed commit SHA — the same identity
 * `GET /health` reports (health-response.ts). No published semver exists for the
 * control plane, and a placeholder like `0.0.0` would make every deploy look
 * identical to a client diffing the contract.
 *
 * Hosted targets must carry a real SHA: throwing beats serving a document that
 * claims to be a build nobody can name. Local and PR CI have no deployment, so
 * they say so by name rather than inventing a version. An unset or unrecognized
 * target throws too: `parsePlatformTarget` would coerce it to `local`, and a
 * production document stamped `local` is a more convincing lie than `0.0.0`.
 */
export function resolveApiDocumentVersion(
  platformTarget: string | undefined,
  deployedCommitSha: string | undefined,
): string {
  if (deployedCommitSha !== undefined) {
    const parsed = FullCommitShaSchema.safeParse(deployedCommitSha);
    if (!parsed.success) {
      throw new Error(
        `SPLITCH_DEPLOYED_COMMIT_SHA "${deployedCommitSha}" is not a full commit SHA`,
      );
    }
    return parsed.data;
  }
  if (isHostedPlatformTarget(platformTarget)) {
    throw new Error(
      `SPLITCH_DEPLOYED_COMMIT_SHA is required to version the OpenAPI document on ${platformTarget}`,
    );
  }
  return requirePlatformTarget(platformTarget);
}

/** Handler the emitter never calls — the app exists only to emit, not to serve. */
function unusedHandler(_c: { json: (body: unknown, status: number) => Response }): never {
  throw new Error("openapi-document: emit-only app must never handle a request");
}

/**
 * Build the public OpenAPI 3.1 document from the registry, on demand. Returns
 * the plain document object (an `OpenAPIObject`) so a caller can `JSON.stringify`
 * it or assert over it; this function does NOT serialize or persist it.
 */
export function buildOpenApiDocument(
  info: OpenApiDocumentInfo,
): ReturnType<OpenAPIHono["getOpenAPI31Document"]> {
  const app = new OpenAPIHono();
  for (const route of routeRegistry) {
    if (publicSurfaceFor(route) === null || route.exposure !== "public") continue;
    app.openapi(route.openapi, unusedHandler);
  }
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: info.title ?? DEFAULT_TITLE, version: info.version },
  });
}
