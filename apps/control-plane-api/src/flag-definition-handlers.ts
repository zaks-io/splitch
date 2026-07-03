import type { HandlerArgs } from "@splitch/worker-runtime";
import {
  createFlag,
  deleteFlag,
  getFlag,
  listFlags,
  updateFlag,
} from "./flag-definition-flag-handlers.js";
import { createVariant, deleteVariant } from "./flag-definition-variant-handlers.js";
import type { FlagDefinitionDeps } from "./flag-definition-handler-utils.js";

export function makeFlagDefinitionHandlers(deps: FlagDefinitionDeps) {
  return {
    listFlags: (args: HandlerArgs<unknown>) => listFlags(deps, args),
    createFlag: (args: HandlerArgs<unknown>) => createFlag(deps, args),
    getFlag: (args: HandlerArgs<unknown>) => getFlag(deps, args),
    updateFlag: (args: HandlerArgs<unknown>) => updateFlag(deps, args),
    deleteFlag: (args: HandlerArgs<unknown>) => deleteFlag(deps, args),
    createVariant: (args: HandlerArgs<unknown>) => createVariant(deps, args),
    deleteVariant: (args: HandlerArgs<unknown>) => deleteVariant(deps, args),
  };
}
