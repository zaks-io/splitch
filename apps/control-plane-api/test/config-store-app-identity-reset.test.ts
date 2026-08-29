import {
  defaultAppEntityIdentityRecordKey,
  mintInitialAppIdentityRecord,
  wrapAppIdentityRecord,
} from "@splitch/privacy";
import { describe, expect, it, vi } from "vitest";
import type { ConfigStoreDurableObjectNamespace } from "../src/config-store-access.js";
import { putConfigStoreAppIdentityIfAbsent } from "../src/config-store-app-identity.js";
import { durableAppIdentityResetAccess } from "../src/config-store-app-identity-access.js";
import {
  beginConfigStoreEntityPrivacy,
  recordConfigStoreEntityPrivacyCompletion,
} from "../src/config-store-app-identity-ledger.js";

describe("durableAppIdentityResetAccess", () => {
  it("routes independent production callers through the same App-scoped Config Store DO", async () => {
    const names: string[] = [];
    const resets: Array<{ appId: string; resetId: string }> = [];
    const namespace = {
      getByName(name: string) {
        names.push(name);
        return {
          async resetCompromisedAppIdentity(appId: string, resetId: string) {
            resets.push({ appId, resetId });
            return "app-v2";
          },
        };
      },
    } as unknown as ConfigStoreDurableObjectNamespace;
    const firstClient = durableAppIdentityResetAccess(namespace);
    const secondClient = durableAppIdentityResetAccess(namespace);

    await expect(
      Promise.all([
        firstClient.resetCompromisedAppIdentity("app-checkout", "reset-compromised"),
        secondClient.resetCompromisedAppIdentity("app-checkout", "reset-compromised"),
      ]),
    ).resolves.toEqual(["app-v2", "app-v2"]);
    expect(names).toEqual(["app-identity:app-checkout", "app-identity:app-checkout"]);
    expect(resets).toEqual([
      { appId: "app-checkout", resetId: "reset-compromised" },
      { appId: "app-checkout", resetId: "reset-compromised" },
    ]);
  });

  it("returns one winner for serialized provisions even when CONFIG_STORE reads stay stale", async () => {
    const rootSecret = "test-root-secret-do-not-use";
    const appId = "app-checkout";
    const first = JSON.stringify(
      await wrapAppIdentityRecord(mintInitialAppIdentityRecord(rootSecret), rootSecret, appId),
    );
    const second = JSON.stringify(
      await wrapAppIdentityRecord(mintInitialAppIdentityRecord(rootSecret), rootSecret, appId),
    );
    const staleKvWrites: string[] = [];
    const ctx = memoryDurableObjectState();
    const env = {
      EVALUATION_PRIVACY_SALT: rootSecret,
      SPLITCH_PLATFORM_TARGET: "production",
      CONFIG_STORE: {
        get: async () => null,
        put: async (_key: string, value: string) => {
          staleKvWrites.push(value);
        },
      },
    } as never;

    await expect(
      Promise.all([
        putConfigStoreAppIdentityIfAbsent(ctx, env, appId, first),
        putConfigStoreAppIdentityIfAbsent(ctx, env, appId, second),
      ]),
    ).resolves.toEqual([first, first]);
    expect(staleKvWrites).toEqual([]);
  });

  it("rejects an in-flight Entity ledger insert after the durable App identity changes", async () => {
    const rootSecret = "test-root-secret-do-not-use";
    const appId = "app-checkout";
    const ctx = memoryDurableObjectState();
    const initial = mintInitialAppIdentityRecord(rootSecret);
    const first = JSON.stringify(await wrapAppIdentityRecord(initial, rootSecret, appId));
    const dbPrepare = vi.fn();
    const env = {
      EVALUATION_PRIVACY_SALT: rootSecret,
      SPLITCH_PLATFORM_TARGET: "production",
      DB: { prepare: dbPrepare },
    } as never;
    await putConfigStoreAppIdentityIfAbsent(ctx, env, appId, first);
    const expectedVersion = await beginConfigStoreEntityPrivacy(ctx, env, appId);
    const active = initial.epochs.find((epoch) => epoch.role === "active");
    if (!active) throw new Error("missing active fixture epoch");
    const replaced = {
      currentVersion: "app-v2",
      lifecycle: { ...initial.lifecycle, resetId: "reset-race" },
      epochs: [{ ...active, version: "app-v2" }],
    };
    await ctx.storage.put(
      defaultAppEntityIdentityRecordKey(appId),
      JSON.stringify(await wrapAppIdentityRecord(replaced, rootSecret, appId)),
    );

    await expect(
      recordConfigStoreEntityPrivacyCompletion(ctx, env, appId, expectedVersion, {
        requestId: "prv_late",
        orgId: "org_1",
        appId,
        requestType: "export",
        subjectRef: '["app-v1:old"]',
        requestedBy: "user_1",
        receivedAt: "2026-08-28T00:00:00.000Z",
        ackDueAt: "2026-09-01T00:00:00.000Z",
        responseDueAt: "2026-10-01T00:00:00.000Z",
        completedAt: "2026-08-28T00:00:00.000Z",
        resultJson: '{"old":"artifact"}',
      }),
    ).rejects.toThrow(/identity changed/iu);
    expect(dbPrepare).not.toHaveBeenCalled();
  });
});

function memoryDurableObjectState(): DurableObjectState {
  const values = new Map<string, unknown>();
  let tail = Promise.resolve();
  return {
    id: { name: "app-identity:app-checkout" },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    },
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const result = tail.then(callback);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  } as unknown as DurableObjectState;
}
