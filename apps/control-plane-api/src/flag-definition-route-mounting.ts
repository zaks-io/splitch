import type { Registrar } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import type { makeFlagDefinitionHandlers } from "./flag-definition-handlers";
import { controlPlaneRoute } from "./routes";

export function mountFlagDefinitionRoutes(
  app: Hono,
  registrar: Registrar,
  handlers: ReturnType<typeof makeFlagDefinitionHandlers>,
): void {
  registrar.mount(app, controlPlaneRoute("flags_list"), handlers.listFlags);
  registrar.mount(app, controlPlaneRoute("principal_flags_list"), handlers.listPrincipalFlags);
  registrar.mount(app, controlPlaneRoute("flags_create"), handlers.createFlag);
  registrar.mount(app, controlPlaneRoute("flags_get"), handlers.getFlag);
  registrar.mount(app, controlPlaneRoute("flags_update"), handlers.updateFlag);
  registrar.mount(app, controlPlaneRoute("flags_delete"), handlers.deleteFlag);
  registrar.mount(app, controlPlaneRoute("flag_variants_create"), handlers.createVariant);
  registrar.mount(app, controlPlaneRoute("flag_variants_update"), handlers.updateVariant);
  registrar.mount(app, controlPlaneRoute("flag_variants_delete"), handlers.deleteVariant);
}
