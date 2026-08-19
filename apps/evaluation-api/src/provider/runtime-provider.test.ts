import { describe, expect, it } from "vitest";
import type { EvaluationApiEnv } from "../env";
import { FakeKv } from "./fake-kv";
import { runtimeKvProvider } from "./runtime-provider";

describe("runtimeKvProvider", () => {
  it("reuses one Provider for the same isolate KV binding", () => {
    const configStore = new FakeKv() as unknown as KVNamespace;
    const env = {
      CONFIG_STORE: configStore,
      CONFIG_STORE_WRITER: { getByName: () => stub() },
    } as unknown as EvaluationApiEnv;

    expect(runtimeKvProvider(env, () => undefined)).toBe(runtimeKvProvider(env, () => undefined));
  });

  it("fails loud when the Config Store DO binding is missing", () => {
    const env = { CONFIG_STORE: new FakeKv() as unknown as KVNamespace } as EvaluationApiEnv;
    expect(() => runtimeKvProvider(env, () => undefined)).toThrow(
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
