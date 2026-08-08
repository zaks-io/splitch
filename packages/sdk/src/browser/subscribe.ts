import type { SdkResolutionDetails } from "../resolution";

export type FlagChangeListener = (details: SdkResolutionDetails) => void;

/**
 * Register a per-Flag change listener. The returned unsubscribe looks up the
 * live set by key so a stale cleanup (React StrictMode) cannot delete a newer
 * listener set that replaced an empty one.
 */
export function registerFlagListener(
  listeners: Map<string, Set<FlagChangeListener>>,
  flagKey: string,
  listener: FlagChangeListener,
): () => void {
  let set = listeners.get(flagKey);
  if (set === undefined) {
    set = new Set();
    listeners.set(flagKey, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(flagKey);
    if (current === undefined) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(flagKey);
    }
  };
}
