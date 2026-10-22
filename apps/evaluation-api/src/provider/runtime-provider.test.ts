import { describe, expect, it, vi } from "vitest";
import type { EvaluationApiEnv } from "../env";
import { FakeKv } from "./fake-kv";
import { runtimeKvProvider } from "./runtime-provider";

const tracing = { enterSpan: vi.fn<Tracing["enterSpan"]>() };

describe("runtimeKvProvider", () => {
  it("reuses one Provider for the same isolate KV binding", () => {
    const configStore = new FakeKv() as unknown as KVNamespace;
    const env = {
      CONFIG_STORE: configStore,
      CONFIG_STORE_WRITER: { getByName: () => stub() },
    } as unknown as EvaluationApiEnv;

    expect(runtimeKvProvider(env, () => undefined, tracing)).toBe(
      runtimeKvProvider(env, () => undefined, tracing),
    );
  });

  it("fails loud when the Config Store DO binding is missing", () => {
    const env = { CONFIG_STORE: new FakeKv() as unknown as KVNamespace } as EvaluationApiEnv;
    expect(() => runtimeKvProvider(env, () => undefined, tracing)).toThrow(
      /CONFIG_STORE_WRITER is required/u,
    );
  });
});

function stub() {
  return {
    fetch: async () => new Response(null, { status: 503 }),
    readFlagConfigForEvaluation: async () => null,
  };
}
