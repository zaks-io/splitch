import type { EvaluationApiEnv } from "../env";
import { DurableConfigUpdates } from "./config-updates";
import { KvProvider, type PropagationBreach } from "./kv-provider";

const providers = new WeakMap<object, KvProvider>();

export function runtimeKvProvider(
  env: EvaluationApiEnv,
  onPropagationBreach: (breach: PropagationBreach) => void,
): KvProvider {
  const cacheKey = env.CONFIG_STORE as object;
  const existing = providers.get(cacheKey);
  if (existing !== undefined) return existing;
  if (env.CONFIG_STORE_WRITER === undefined) {
    throw new Error("evaluation-api: CONFIG_STORE_WRITER is required");
  }

  const provider = new KvProvider(env.CONFIG_STORE, {
    configUpdates: new DurableConfigUpdates(env.CONFIG_STORE_WRITER),
    onPropagationBreach,
  });
  providers.set(cacheKey, provider);
  return provider;
}
