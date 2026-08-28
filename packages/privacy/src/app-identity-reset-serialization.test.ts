import { describe, expect, it } from "vitest";
import { makeInProcessAppIdentityExclusive } from "./app-identity-exclusive";
import type { AppIdentityResetPurgers } from "./app-identity-reset";
import { resetCompromisedAppIdentity } from "./app-identity-reset";
import { makeKvAppIdentityStore, provisionAppIdentity } from "./app-identity-store";
import { toHex } from "./hmac";

const ROOT = "test-root-secret-do-not-use";
const APP_ID = "app_1";

function memoryKv() {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function successfulPurgers(calls: string[] = []): AppIdentityResetPurgers {
  const purge = (surface: string) => async () => {
    calls.push(surface);
    return `proof:${surface}`;
  };
  return {
    runs_and_credentials: purge("runs_and_credentials"),
    delivery: purge("delivery"),
    assignments: purge("assignments"),
    analytics: purge("analytics"),
    retry_claims: purge("retry_claims"),
    entity_deletions: purge("entity_deletions"),
    privacy_subject_refs: purge("privacy_subject_refs"),
  };
}

describe("App identity reset serialization", () => {
  it("refuses the process-local KV reset path", async () => {
    const kv = memoryKv();
    const store = makeKvAppIdentityStore({ kv, rootSecret: ROOT });
    await provisionAppIdentity(store, APP_ID, ROOT);
    await expect(
      resetCompromisedAppIdentity(store, APP_ID, "reset-1", successfulPurgers()),
    ).rejects.toThrow(/durable serialized owner/);
  });

  it("one durable owner serializes two independent KV clients onto one replacement key", async () => {
    const kv = memoryKv();
    const first = makeKvAppIdentityStore({ kv, rootSecret: ROOT, durablySerializedReset: true });
    const second = makeKvAppIdentityStore({ kv, rootSecret: ROOT, durablySerializedReset: true });
    await provisionAppIdentity(first, APP_ID, ROOT);
    const durableOwner = makeInProcessAppIdentityExclusive();
    const calls: string[] = [];
    const purgers = successfulPurgers(calls);
    const reset = (store: typeof first) =>
      durableOwner.runExclusive(APP_ID, () =>
        resetCompromisedAppIdentity(store, APP_ID, "reset-durable", purgers),
      );

    const [left, right] = await Promise.all([reset(first), reset(second)]);
    const leftKey = left.epochs.find((epoch) => epoch.role === "active")?.key;
    const rightKey = right.epochs.find((epoch) => epoch.role === "active")?.key;
    expect(leftKey).toBeDefined();
    expect(rightKey).toBeDefined();
    expect(toHex(leftKey ?? new Uint8Array())).toBe(toHex(rightKey ?? new Uint8Array()));
    expect(calls).toHaveLength(7);
    expect((await first.load(APP_ID))?.currentVersion).toBe("app-v2");
  });
});
