import type { Repository } from "@splitch/db";
import type { Registrar } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { makeFlagChangeHandlers } from "./flag-change-handlers";
import type { makeFlagDefinitionHandlers } from "./flag-definition-handlers";
import { replayTolerantCreateRoute } from "./flag-create-replay";
import { controlPlaneRoute } from "./routes";

export function mountFlagDefinitionRoutes(
  app: Hono,
  registrar: Registrar,
  handlers: ReturnType<typeof makeFlagDefinitionHandlers>,
  repo: Repository,
): void {
  registrar.mount(app, controlPlaneRoute("flags_list"), handlers.listFlags);
  registrar.mount(app, controlPlaneRoute("principal_flags_list"), handlers.listPrincipalFlags);
  registrar.mount(app, controlPlaneRoute("expired_flags_list"), handlers.listExpiredFlags);
  registrar.mount(
    app,
    replayTolerantCreateRoute(controlPlaneRoute("flags_create")),
    handlers.createFlag,
  );
  registrar.mount(app, controlPlaneRoute("flags_get"), handlers.getFlag);
  registrar.mount(app, controlPlaneRoute("flags_update"), handlers.updateFlag);
  registrar.mount(app, controlPlaneRoute("flags_delete"), handlers.deleteFlag);
  registrar.mount(app, controlPlaneRoute("flag_variants_create"), handlers.createVariant);
  registrar.mount(app, controlPlaneRoute("flag_variants_update"), handlers.updateVariant);
  registrar.mount(app, controlPlaneRoute("flag_variants_delete"), handlers.deleteVariant);
  const flagChanges = makeFlagChangeHandlers({ repo });
  registrar.mount(app, controlPlaneRoute("flag_changes_list"), flagChanges.list);
  registrar.mount(app, controlPlaneRoute("flag_changes_export"), flagChanges.export);
}
