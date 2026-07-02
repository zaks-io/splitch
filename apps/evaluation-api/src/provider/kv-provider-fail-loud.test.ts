import { experimentConfigKey, flagConfigKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { FakeKv } from "./fake-kv.js";
import { experimentConfigKV, flagConfigKV } from "./fixtures.js";
import { KvProvider } from "./kv-provider.js";
import { ProviderError } from "./provider.js";

const KEY = flagConfigKey("app-A", "env-1", "f");

async function expectProviderError(
  promise: Promise<unknown>,
  errorCode: ProviderError["errorCode"] = "INTERNAL_SERVER_ERROR",
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ProviderError);
  await promise.catch((err: unknown) => {
    expect((err as ProviderError).errorCode).toBe(errorCode);
  });
}

describe("KvProvider fail-loud (malformed KV never yields a half-valid config)", () => {
  it("throws FLAG_NOT_FOUND on a flag KV miss", async () => {
    const provider = new KvProvider(new FakeKv());
    await expectProviderError(provider.getFlag("app-A", "env-1", "f"), "FLAG_NOT_FOUND");
  });

  it("throws on malformed (non-JSON) bytes", async () => {
    const kv = new FakeKv().putRaw(KEY, "{not json");
    await expectProviderError(new KvProvider(kv).getFlag("app-A", "env-1", "f"));
  });

  it("throws on a partial blob missing a required field", async () => {
    const partial = flagConfigKV();
    // @ts-expect-error deliberately drop a required field to make the blob partial
    delete partial.enabled;
    const kv = new FakeKv().put(KEY, partial);
    await expectProviderError(new KvProvider(kv).getFlag("app-A", "env-1", "f"));
  });

  it("throws on an unexpected extra key (.strict() rejects it)", async () => {
    const kv = new FakeKv().put(KEY, { ...flagConfigKV(), surprise: true });
    await expectProviderError(new KvProvider(kv).getFlag("app-A", "env-1", "f"));
  });

  it("throws when experimentId is OMITTED (must be null-or-id, never absent)", async () => {
    const blob = flagConfigKV();
    // @ts-expect-error experimentId is required-nullable, not optional
    delete blob.experimentId;
    const kv = new FakeKv().put(KEY, blob);
    await expectProviderError(new KvProvider(kv).getFlag("app-A", "env-1", "f"));
  });

  it("throws on an UNKNOWN-but-valid schema version (a future blob is not mistaken for current)", async () => {
    // The payload satisfies today's inner schema; only the version is unknown.
    // The version is GATED, not merely bounded below, so this must fail loud — a
    // schemaVersion:0 floor test would not catch this regression.
    const kv = new FakeKv().put(KEY, flagConfigKV(), 2);
    await expectProviderError(new KvProvider(kv).getFlag("app-A", "env-1", "f"));
  });

  it("throws when the envelope wrapper itself is missing", async () => {
    const kv = new FakeKv().putRaw(KEY, JSON.stringify(flagConfigKV()));
    await expectProviderError(new KvProvider(kv).getFlag("app-A", "env-1", "f"));
  });

  it("throws on a corrupt Run blob during getExperiment (no half-hydrated Experiment)", async () => {
    const kv = new FakeKv()
      .put(experimentConfigKey("app-A", "env-1", "exp-7"), experimentConfigKV())
      .put("app:app-A:env-1:run:run-42", { id: "run-42", experimentId: "exp-7" });
    await expectProviderError(new KvProvider(kv).getExperiment("app-A", "env-1", "exp-7"));
  });
});
