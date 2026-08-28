import type { AssignmentStore } from "./assignment-store";

/**
 * One Assignment Store getAll per evaluate-all request. evaluatePath calls
 * getAll once per experiment-backed Flag; memoizing by identity collapses that
 * to the single read the evaluate-all spec requires.
 */
export function memoizeGetAll(store: AssignmentStore): AssignmentStore {
  let cached: {
    key: string;
    value: ReturnType<AssignmentStore["getAll"]>;
  } | null = null;
  return {
    getAll(input) {
      const key = `${input.appId}\0${input.idType}\0${input.targetingKey}\0${input.identityVersion ?? ""}`;
      if (cached?.key === key) return cached.value;
      const value = store.getAll(input);
      cached = { key, value };
      return value;
    },
    put(input) {
      return store.put(input);
    },
    putHashed(input) {
      return store.putHashed(input);
    },
  };
}
