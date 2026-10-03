import type { HandlerArgs } from "@splitch/worker-runtime";
import { listExpiredFlags } from "./expired-flag-list-handler";
import { createFlag } from "./flag-definition-create";
import { deleteFlag } from "./flag-definition-flag-delete";
import { getFlag, listFlags, updateFlag } from "./flag-definition-flag-handlers";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils";
import { getFlagInventoryHealth } from "./flag-inventory-health-handler";
import { getFlagRemovalBrief } from "./flag-removal-brief-handler";
import { createVariant, deleteVariant } from "./flag-definition-variant-catalog";
import { updateVariant } from "./flag-definition-variant-handlers";
import { listPrincipalFlags } from "./principal-flag-list-handler";
import { listStaleFlags } from "./stale-flag-list-handler";

export function makeFlagDefinitionHandlers(deps: FlagDefinitionDeps) {
  return {
    listFlags: (args: HandlerArgs<unknown>) => listFlags(deps, args),
    listPrincipalFlags: (args: HandlerArgs<unknown>) => listPrincipalFlags(deps, args),
    listExpiredFlags: (args: HandlerArgs<unknown>) => listExpiredFlags(deps, args),
    listStaleFlags: (args: HandlerArgs<unknown>) => listStaleFlags(deps, args),
    getFlagInventoryHealth: (args: HandlerArgs<unknown>) => getFlagInventoryHealth(deps, args),
    getFlagRemovalBrief: (args: HandlerArgs<unknown>) => getFlagRemovalBrief(deps, args),
    createFlag: (args: HandlerArgs<unknown>) => createFlag(deps, args),
    getFlag: (args: HandlerArgs<unknown>) => getFlag(deps, args),
    updateFlag: (args: HandlerArgs<unknown>) => updateFlag(deps, args),
    deleteFlag: (args: HandlerArgs<unknown>) => deleteFlag(deps, args),
    createVariant: (args: HandlerArgs<unknown>) => createVariant(deps, args),
    updateVariant: (args: HandlerArgs<unknown>) => updateVariant(deps, args),
    deleteVariant: (args: HandlerArgs<unknown>) => deleteVariant(deps, args),
  };
}
