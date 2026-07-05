import { OpenAPIHono } from "@hono/zod-openapi";
import { routeRegistry } from "./route-registry";

/**
 * Type-only OpenAPIHono built from THE route registry so `hc<ControlPlaneClientApp>()`
 * infers per-route input/output from the same Zod schemas the Worker mounts and MCP
 * derives. The app is never served; it exists only to thread contract types into
 * @splitch/control-plane-sdk without importing deployable Worker code.
 */

/** `hc<ControlPlaneClientApp>()` generic — inferred from the registry, zero codegen. */
export type ControlPlaneClientApp = OpenAPIHono;

/** Build the emit-only Hono app every registered route is mounted on. */
export function createControlPlaneClientApp(): ControlPlaneClientApp {
  const app = new OpenAPIHono();
  for (const route of routeRegistry) {
    app.openapi(route.openapi, (c) => {
      const empty = route.output.safeParse(undefined);
      const body = empty.success ? empty.data : {};
      return c.json(body, 200);
    });
  }
  return app;
}
