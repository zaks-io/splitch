import { isLocalPlatformTarget, requirePlatformTarget } from "@splitch/contracts";
import {
  type AppIdentityKv,
  type AppIdentityStore,
  makeDurableAppIdentityPutIfAbsent,
  makeIdentitySaltStore,
  makeKvAppIdentityStore,
  makeMemoryAppIdentityStore,
  putWrappedAppIdentityIfAbsent,
  resolvePrivacyRootSecret,
  type SaltStore,
} from "@splitch/privacy";

export function makeEnvSaltStore(env: {
  EVALUATION_PRIVACY_SALT?: string;
  SPLITCH_PLATFORM_TARGET?: string;
  CONFIG_STORE?: AppIdentityKv;
  CONFIG_STORE_WRITER?: {
    getByName(name: string): {
      putAppIdentityIfAbsent?(recordKey: string, value: string): Promise<string>;
    };
  };
  identityStore?: AppIdentityStore;
}): SaltStore {
  const target = requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  const rootSecret = resolvePrivacyRootSecret({
    configuredSalt: env.EVALUATION_PRIVACY_SALT,
    localFixtureAllowed: isLocalPlatformTarget(target),
  });
  return makeIdentitySaltStore({
    rootSecret,
    identityStore: resolveIdentityStore(env, target, rootSecret),
  });
}

function resolveIdentityStore(
  env: {
    CONFIG_STORE?: AppIdentityKv;
    CONFIG_STORE_WRITER?: {
      getByName(name: string): {
        putAppIdentityIfAbsent?(recordKey: string, value: string): Promise<string>;
      };
    };
    identityStore?: AppIdentityStore;
  },
  target: ReturnType<typeof requirePlatformTarget>,
  rootSecret: string,
): AppIdentityStore {
  if (env.identityStore) return env.identityStore;
  if (env.CONFIG_STORE) {
    return makeKvAppIdentityStore({
      kv: asAppIdentityKv(env.CONFIG_STORE),
      rootSecret,
      putIfAbsent: appIdentityPutIfAbsent(env.CONFIG_STORE, env.CONFIG_STORE_WRITER),
    });
  }
  if (isLocalPlatformTarget(target)) {
    return makeMemoryAppIdentityStore();
  }
  throw new Error("CONFIG_STORE is required outside local targets");
}

function appIdentityPutIfAbsent(
  kv: AppIdentityKv,
  writer:
    | {
        getByName(name: string): {
          putAppIdentityIfAbsent?(recordKey: string, value: string): Promise<string>;
        };
      }
    | undefined,
): (recordKey: string, value: string) => Promise<string> {
  if (writer === undefined) {
    return (recordKey, value) =>
      putWrappedAppIdentityIfAbsent(asAppIdentityKv(kv), recordKey, value);
  }
  const durable = makeDurableAppIdentityPutIfAbsent({
    getByName(name) {
      const stub = writer.getByName(name);
      if (typeof stub.putAppIdentityIfAbsent !== "function") {
        throw new Error("evaluation-api: App identity coordinator is unavailable");
      }
      return { putAppIdentityIfAbsent: stub.putAppIdentityIfAbsent.bind(stub) };
    },
  });
  return async (recordKey, value) => {
    try {
      return await durable(recordKey, value);
    } catch (cause) {
      if (cause instanceof Error && /coordinator is unavailable/u.test(cause.message)) {
        return putWrappedAppIdentityIfAbsent(asAppIdentityKv(kv), recordKey, value);
      }
      throw cause;
    }
  };
}

function asAppIdentityKv(kv: AppIdentityKv): AppIdentityKv {
  return {
    get: (key) => kv.get(key),
    put: (key, value) => kv.put(key, value),
  };
}
