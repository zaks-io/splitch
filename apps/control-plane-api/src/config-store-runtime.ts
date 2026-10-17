import { makeConfigStoreMutationQueue } from "./config-store-mutation-queue";
import { journaledConfigStoreKv } from "./config-store-projection-journal";
import type { ConfigStoreDeps, ConfigStoreRuntimeDeps } from "./config-store-types";

export function makeConfigStoreRuntimeDeps(deps: ConfigStoreDeps): ConfigStoreRuntimeDeps {
  const journaledKv = journaledConfigStoreKv(deps.kv, deps.projectionJournal);
  const unresolvedKv = new Proxy(deps.kv, {
    get(target, property) {
      if (property === "put") {
        return async () => {
          throw new Error("config-store: Environment kind has not been read from D1");
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime: ConfigStoreRuntimeDeps = {
    ...deps,
    kv: unresolvedKv,
    snapshotMutations: makeConfigStoreMutationQueue(),
    observeEnvironment(environment) {
      runtime.kv =
        environment === null
          ? unresolvedKv
          : environment.expiresAt === null
            ? deps.kv
            : journaledKv;
    },
  };
  return runtime;
}
