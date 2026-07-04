import type { AppEnvironmentDeps } from "./app-environment-model";
import { makeAppHandlers } from "./app-handlers";
import { makeEnvironmentHandlers } from "./environment-handlers";

export function makeAppEnvironmentHandlers(deps: AppEnvironmentDeps) {
  return {
    ...makeAppHandlers(deps),
    ...makeEnvironmentHandlers(deps),
  };
}
