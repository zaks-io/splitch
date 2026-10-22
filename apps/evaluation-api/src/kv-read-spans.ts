/** Native-only attributes preserve cache attribution without widening the Sentry scrubber. */
export function observedKvReads(
  kv: KVNamespace,
  tracing: Pick<Tracing, "enterSpan">,
  binding: "configuration" | "credentials" | "assignments",
) {
  return {
    get(key: string): Promise<string | null> {
      return tracing.enterSpan(`Read ${binding} KV`, async (span) => {
        const result = await kv.getWithMetadata(key, "text");
        const status = cacheStatus(result.cacheStatus);
        if (status !== undefined) span.setAttribute("kv.cache_status", status);
        return result.value;
      });
    },
    list: (options: KVNamespaceListOptions) => kv.list(options),
    put: (key: string, value: string) => kv.put(key, value),
    delete: (key: string) => kv.delete(key),
  };
}

function cacheStatus(value: string | null | undefined): string | undefined {
  // Only bounded operational values may enter native traces, never arbitrary metadata.
  const normalized = value?.toLowerCase();
  return normalized === "hit" || normalized === "miss" || normalized === "expired"
    ? normalized
    : undefined;
}
