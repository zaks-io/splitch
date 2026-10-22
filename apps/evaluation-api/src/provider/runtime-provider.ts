import type { EvaluationApiEnv } from "../env";
import { observedKvReads } from "../kv-read-spans";
import { DurableConfigUpdates, type WaitUntil } from "./config-updates";
import { KvProvider, type PropagationBreach } from "./kv-provider";

interface CachedRuntimeProvider {
  provider: KvProvider;
  updates: DurableConfigUpdates;
}

const providers = new WeakMap<object, CachedRuntimeProvider>();

export function runtimeKvProvider(
  env: EvaluationApiEnv,
  onPropagationBreach: (breach: PropagationBreach) => void,
  tracing: Pick<Tracing, "enterSpan">,
  waitUntil?: WaitUntil,
): KvProvider {
  const cacheKey = env.CONFIG_STORE as object;
  const existing = providers.get(cacheKey);
  if (existing !== undefined) {
    existing.updates.setWaitUntil(waitUntil);
    return existing.provider;
  }
  if (env.CONFIG_STORE_WRITER === undefined) {
    throw new Error("evaluation-api: CONFIG_STORE_WRITER is required");
  }

  const updates = new DurableConfigUpdates(env.CONFIG_STORE_WRITER);
  updates.setWaitUntil(waitUntil);
  const provider = new KvProvider(observedKvReads(env.CONFIG_STORE, tracing, "configuration"), {
    configUpdates: updates,
    onPropagationBreach,
  });
  providers.set(cacheKey, { provider, updates });
  return provider;
}
