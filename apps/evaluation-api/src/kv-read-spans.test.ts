import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { describe, expect, it, vi } from "vitest";
import { observedKvReads } from "./kv-read-spans";

function nativeSpans() {
  const spans: { name: string; attributes: Record<string, string> }[] = [];
  const tracing: Pick<Tracing, "enterSpan"> = {
    enterSpan<T, A extends unknown[]>(
      name: string,
      run: (span: Span, ...args: A) => T,
      ...args: A
    ): T {
      const record = { name, attributes: {} };
      spans.push(record);
      const span = {
        setAttribute: (key: string, value: string) =>
          Object.assign(record.attributes, { [key]: value }),
      } as unknown as Span;
      return run(span, ...args);
    },
  };
  return { tracing, spans };
}

describe("KV cache attribution", () => {
  it.each(["HIT", "MISS", "EXPIRED", null, undefined, "private@example.com"])(
    "records only bounded cache status for %s and never the key or value",
    async (cacheStatus) => {
      const getWithMetadata = vi.fn().mockResolvedValue({ value: "private value", cacheStatus });
      const kv = { getWithMetadata } as unknown as KVNamespace;
      const { tracing, spans } = nativeSpans();
      const reader = observedKvReads(kv, tracing, "credentials");

      await expect(reader.get("private-key")).resolves.toBe("private value");

      expect(getWithMetadata).toHaveBeenCalledWith("private-key", "text");
      expect(spans[0]?.attributes).toEqual(
        ["HIT", "MISS", "EXPIRED"].includes(cacheStatus ?? "")
          ? { "kv.cache_status": cacheStatus?.toLowerCase() }
          : {},
      );
      expect(spans[0]?.name).toBe("Read credentials KV");
      expect(JSON.stringify(spans)).not.toContain("private");
    },
  );

  it("preserves failed reads without recording their messages", async () => {
    const error = new Error("KV unavailable");
    const kv = { getWithMetadata: vi.fn().mockRejectedValue(error) } as unknown as KVNamespace;
    const { tracing, spans } = nativeSpans();
    await expect(observedKvReads(kv, tracing, "assignments").get("key")).rejects.toBe(error);
    expect(spans[0]).toEqual({ name: "Read assignments KV", attributes: {} });
  });

  it("reads present and absent values through the real Workers KV API", async () => {
    const bundle = await build({
      stdin: {
        contents: `import { tracing } from "cloudflare:workers";
          import { observedKvReads } from "./src/kv-read-spans";
          export default { async fetch(request, env) {
            const reader = observedKvReads(env.STORE, tracing, "configuration");
            return Response.json([await reader.get("flag"), await reader.get("absent")]);
          } };`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "esm",
      external: ["cloudflare:workers"],
    });
    const mf = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0]?.text,
      compatibilityDate: "2026-07-30",
      kvNamespaces: ["STORE"],
    });
    try {
      const kv = await mf.getKVNamespace("STORE");
      const { tracing, spans } = nativeSpans();
      const reader = observedKvReads(kv as unknown as KVNamespace, tracing, "configuration");
      await reader.put("flag", "config");
      await expect(reader.get("flag")).resolves.toBe("config");
      await expect(reader.get("absent")).resolves.toBeNull();
      expect(spans).toHaveLength(2);
      expect(spans.every((span) => span.name === "Read configuration KV")).toBe(true);
      const response = await mf.dispatchFetch("http://localhost/read");
      expect(response.status, await response.clone().text()).toBe(200);
      await expect(response.json()).resolves.toEqual(["config", null]);
    } finally {
      await mf.dispose();
    }
  });
});
