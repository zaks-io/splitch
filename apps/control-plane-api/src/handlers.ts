import type { Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";

/**
 * Minimal-but-real control-plane handlers for the mounted routes. They run AFTER
 * the guard has resolved the Principal and enforced scopes + App co-scope, so by
 * the time a handler executes the caller is authorized for this App: the guard
 * already rejected a null/mismatched-App principal with FORBIDDEN before any
 * repository call (steps/scopes.ts). The handler reads through the @splitch/db
 * repository seam (the only D1 entry, ADR-0018), never a raw client.
 *
 * Domain breadth is intentionally narrow (read one App, read one Org): this slice
 * is the auth middleware, not the full Org/App CRUD surface. The handlers exist
 * to exercise the authorized path end to end.
 *
 * The registry erases the route's Zod generics to `unknown` at the registrar
 * boundary, so each handler re-reads the single path param it needs from the
 * already-validated input, failing loud if the expected shape is somehow absent
 * (it cannot be: parseInput validated it against the contract first).
 */

interface HandlerDeps {
  repo: Repository;
}

function pathParam(input: unknown, key: string): string {
  const params = (input as { params?: Record<string, unknown> } | null)?.params;
  const value = params?.[key];
  if (typeof value !== "string") {
    throw new Error(`control-plane-api: validated input is missing path param "${key}"`);
  }
  return value;
}

export function makeHandlers(deps: HandlerDeps) {
  return {
    async getApp({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const app = await deps.repo.identity.getApp(pathParam(input, "appId"));
      if (!app) {
        return renderError(
          { code: "APP_NOT_FOUND", message: "app not found", details: {} },
          { requestId },
        );
      }
      return Response.json({
        id: app.id,
        organizationId: app.organizationId,
        name: app.name,
        key: app.key,
        ...(app.description ? { description: app.description } : {}),
        createdAt: app.createdAt,
        updatedAt: app.updatedAt,
      });
    },

    async getOrg({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      const org = await deps.repo.identity.getOrg(pathParam(input, "orgId"));
      if (!org) {
        return renderError(
          { code: "ORGANIZATION_NOT_FOUND", message: "organization not found", details: {} },
          { requestId },
        );
      }
      return Response.json({
        id: org.id,
        name: org.name,
        plan: org.plan,
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
      });
    },
  };
}
