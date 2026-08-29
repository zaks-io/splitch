import {
  computeTargetingKeyHash,
  mintInitialAppIdentityRecord,
  wrapAppIdentityRecord,
} from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { makeMetricEventSaltStore } from "./metric-event-salt-store";

describe("Metric Event privacy salts", () => {
  it("hashes the same Targeting Key differently across Apps under one root", async () => {
    const values = new Map<string, string>();
    const writer = {
      getByName: () => ({
        async readAppIdentity(appId: string) {
          return values.get(`app:${appId}:entity-identity`) ?? null;
        },
        async putAppIdentityIfAbsent(appId: string, value: string) {
          const key = `app:${appId}:entity-identity`;
          const winner = values.get(key);
          if (winner !== undefined) return winner;
          values.set(key, value);
          return value;
        },
      }),
    };
    const store = makeMetricEventSaltStore({
      EVALUATION_PRIVACY_SALT: "test-root-secret-do-not-use",
      SPLITCH_PLATFORM_TARGET: "production",
      CONFIG_STORE: {
        get: async (key: string) => values.get(key) ?? null,
        put: async (key: string, value: string) => {
          values.set(key, value);
        },
      },
      CONFIG_STORE_WRITER: writer,
    } as never);
    const input = { idType: "user", targetingKey: "user-123" } as const;
    const appA = await computeTargetingKeyHash(store, { ...input, appId: "app_1" });
    const appB = await computeTargetingKeyHash(store, { ...input, appId: "app_2" });
    expect(appA.startsWith("app-v1:")).toBe(true);
    expect(appB.startsWith("app-v1:")).toBe(true);
    expect(appA).not.toBe(appB);
    const historical = await computeTargetingKeyHash(store, {
      ...input,
      appId: "app_1",
      keyVersion: "v1",
    });
    expect(historical).toBe("v1:485bdba84f840c9627db32bcc99a6f00722b5253754e513ff473c90a8febc588");
    expect(historical).not.toBe(appA);
  });

  it("rejects a stale KV identity while the authoritative reset state is blocked", async () => {
    const rootSecret = "test-root-secret-do-not-use";
    const appId = "app_1";
    const active = mintInitialAppIdentityRecord(rootSecret);
    const stale = JSON.stringify(await wrapAppIdentityRecord(active, rootSecret, appId));
    const blocked = JSON.stringify(
      await wrapAppIdentityRecord(
        {
          ...active,
          lifecycle: {
            state: "blocked",
            trafficBlocked: true,
            resetId: "reset-1",
            proofs: {
              runs_and_credentials: null,
              delivery: null,
              assignments: null,
              analytics: null,
              retry_claims: null,
              entity_deletions: null,
              privacy_subject_refs: null,
            },
            releaseProofs: { evaluation: null, event_ingest: null },
          },
        },
        rootSecret,
        appId,
      ),
    );
    let kvReads = 0;
    const store = makeMetricEventSaltStore({
      EVALUATION_PRIVACY_SALT: rootSecret,
      SPLITCH_PLATFORM_TARGET: "production",
      CONFIG_STORE: {
        get: async () => {
          kvReads += 1;
          return stale;
        },
        put: async () => undefined,
      },
      CONFIG_STORE_WRITER: {
        getByName: () => ({
          readAppIdentity: async () => blocked,
          putAppIdentityIfAbsent: async () => blocked,
        }),
      },
    } as never);

    await expect(
      computeTargetingKeyHash(store, { appId, idType: "user", targetingKey: "user-123" }),
    ).rejects.toThrow(/App identity traffic is blocked/);
    expect(kvReads).toBe(0);
  });

  it("rejects missing hosted identity configuration", () => {
    expect(() => makeMetricEventSaltStore({} as never)).toThrow(/SPLITCH_PLATFORM_TARGET/);
    expect(() =>
      makeMetricEventSaltStore({ SPLITCH_PLATFORM_TARGET: "production" } as never),
    ).toThrow(/EVALUATION_PRIVACY_SALT/);
    expect(() =>
      makeMetricEventSaltStore({
        EVALUATION_PRIVACY_SALT: "hosted-root-secret",
        SPLITCH_PLATFORM_TARGET: "production",
      } as never),
    ).toThrow(/CONFIG_STORE is required/);
    expect(() =>
      makeMetricEventSaltStore({
        EVALUATION_PRIVACY_SALT: "hosted-root-secret",
        SPLITCH_PLATFORM_TARGET: "production",
        CONFIG_STORE: { get: async () => null, put: async () => undefined },
      } as never),
    ).toThrow(/CONFIG_STORE_WRITER is required/);
  });

  it("fails closed when the hosted writer does not expose the atomic RPC", async () => {
    const store = makeMetricEventSaltStore({
      EVALUATION_PRIVACY_SALT: "hosted-root-secret",
      SPLITCH_PLATFORM_TARGET: "production",
      CONFIG_STORE: { get: async () => null, put: async () => undefined },
      CONFIG_STORE_WRITER: { getByName: () => ({}) },
    } as never);
    await expect(
      computeTargetingKeyHash(store, {
        appId: "app_1",
        idType: "user",
        targetingKey: "user-123",
      }),
    ).rejects.toThrow(/coordinator is unavailable/);
  });
});
