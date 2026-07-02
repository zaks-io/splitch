import type { AppEnvironmentDeps } from "./app-environment-model.js";
import { makeAppHandlers } from "./app-handlers.js";
import { makeEnvironmentHandlers } from "./environment-handlers.js";

export function makeAppEnvironmentHandlers(deps: AppEnvironmentDeps) {
  return {
    ...makeAppHandlers(deps),
    ...makeEnvironmentHandlers(deps),
  };
}
