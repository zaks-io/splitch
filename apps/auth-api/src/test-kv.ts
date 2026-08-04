/**
 * Shared in-memory KVNamespace for auth-api route/fixture tests.
 * One authoring point so device/oauth/claim harnesses cannot drift.
 */
export function memoryKvNamespace(values: Map<string, string> = new Map()): KVNamespace {
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}
