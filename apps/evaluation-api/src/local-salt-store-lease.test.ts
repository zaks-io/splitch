import {
  computeTargetingKeyHash,
  makeDurableAppIdentityStore,
  mintInitialAppIdentityRecord,
  wrapAppIdentityRecord,
} from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { makeEnvSaltStore } from "./local-salt-store";

const ROOT = "test-root-secret-do-not-use";

describe("makeEnvSaltStore App identity leases", () => {
  it("reuses one authoritative App identity lease across hashing work", async () => {
    const appId = "app_1";
    const wrapped = JSON.stringify(
      await wrapAppIdentityRecord(mintInitialAppIdentityRecord(ROOT), ROOT, appId),
    );
    let leaseReads = 0;
    const namespace = {
      getByName: () => ({
        async readAppIdentity(_appId: string, options?: { readonly lease: true }) {
          if (options?.lease === true) {
            leaseReads += 1;
            return { value: wrapped, expiresAt: Date.now() + 10_000 };
          }
          return wrapped;
        },
        async putAppIdentityIfAbsent() {
          return wrapped;
        },
      }),
    };
    const first = hostedStore(namespace);
    const second = hostedStore(namespace);
    const input = { appId, idType: "user", targetingKey: "user-123" };

    await Promise.all([
      computeTargetingKeyHash(first, input),
      computeTargetingKeyHash(first, input),
      computeTargetingKeyHash(second, input),
    ]);
    await computeTargetingKeyHash(second, input);

    expect(leaseReads).toBe(1);
  });

  it("coalesces but does not cache reads from a pre-lease server", async () => {
    const appId = "app_1";
    const wrapped = JSON.stringify(
      await wrapAppIdentityRecord(mintInitialAppIdentityRecord(ROOT), ROOT, appId),
    );
    let reads = 0;
    let releaseRead = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const namespace = {
      getByName: () => ({
        async readAppIdentity() {
          reads += 1;
          await readGate;
          return wrapped;
        },
        async putAppIdentityIfAbsent() {
          return wrapped;
        },
      }),
    };
    const store = makeDurableAppIdentityStore({ namespace, rootSecret: ROOT });
    const concurrent = Promise.all([store.load(appId), store.load(appId)]);
    await Promise.resolve();
    expect(reads).toBe(1);
    releaseRead();
    await concurrent;

    await store.load(appId);
    expect(reads).toBe(2);
  });
});

function hostedStore(namespace: Parameters<typeof makeDurableAppIdentityStore>[0]["namespace"]) {
  return makeEnvSaltStore({
    EVALUATION_PRIVACY_SALT: ROOT,
    SPLITCH_PLATFORM_TARGET: "production",
    CONFIG_STORE: { get: async () => null, put: async () => undefined },
    CONFIG_STORE_WRITER: namespace,
  });
}
