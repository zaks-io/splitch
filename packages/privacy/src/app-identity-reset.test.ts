import { describe, expect, it } from "vitest";
import {
  type AppIdentityResetPurgers,
  type AppIdentityResetReleasers,
  resetCompromisedAppIdentity,
} from "./app-identity-reset";
import { makeMemoryAppIdentityStore, provisionAppIdentity } from "./app-identity-store";
import { makeIdentitySaltStore } from "./derived-salt-store";
import { computeTargetingKeyHash } from "./hash";

const ROOT = "test-root-secret-do-not-use";
const input = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

describe("App identity compromised reset", () => {
  it("refuses to reset an unprovisioned App", async () => {
    await expect(
      resetCompromisedAppIdentity(
        makeMemoryAppIdentityStore(),
        "app_new",
        "reset-1",
        successfulPurgers(),
        successfulReleasers(),
      ),
    ).rejects.toThrow(/unprovisioned/);
  });

  it("keeps traffic blocked and resumes from durable store proofs", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    await provisionAppIdentity(identityStore, input.appId, ROOT);
    const saltStore = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    const calls: string[] = [];
    const first = successfulPurgers(calls);
    first.analytics = async () => {
      calls.push("analytics");
      throw new Error("analytics purge unavailable");
    };
    await expect(
      resetCompromisedAppIdentity(
        identityStore,
        input.appId,
        "reset-1",
        first,
        successfulReleasers(),
      ),
    ).rejects.toThrow(/analytics purge unavailable/);
    await expect(saltStore.retainedKeyVersions(input.appId)).rejects.toThrow(/traffic is blocked/);

    const resumedCalls: string[] = [];
    const replaced = await resetCompromisedAppIdentity(
      identityStore,
      input.appId,
      "reset-1",
      successfulPurgers(resumedCalls),
      successfulReleasers(),
    );
    expect(replaced.currentVersion).toBe("app-v2");
    expect(resumedCalls).toEqual([
      "analytics",
      "retry_claims",
      "entity_deletions",
      "privacy_subject_refs",
    ]);
  });

  it("replaces the live key only after every destructive checkpoint", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const saltStore = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    const before = await computeTargetingKeyHash(saltStore, input);
    const calls: string[] = [];
    const replaced = await resetCompromisedAppIdentity(
      identityStore,
      input.appId,
      "reset-1",
      successfulPurgers(calls),
      successfulReleasers(calls),
    );
    expect(replaced.currentVersion).toBe("app-v2");
    expect(replaced.epochs).toHaveLength(1);
    expect(await computeTargetingKeyHash(saltStore, input)).not.toBe(before);
    await expect(saltStore.saltFor(input.appId, "app-v1")).rejects.toThrow(/unknown salt version/);
    const retry = await resetCompromisedAppIdentity(
      identityStore,
      input.appId,
      "reset-1",
      successfulPurgers(calls),
      successfulReleasers(calls),
    );
    expect(retry.currentVersion).toBe("app-v2");
    expect(calls).toHaveLength(9);
  });
});

describe("App identity reset activation", () => {
  it("freezes every active, retained, and lookup epoch for destructive purgers", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    await provisionAppIdentity(identityStore, input.appId, ROOT);
    const observed: string[][] = [];
    const purgers = successfulPurgers();
    purgers.analytics = async ({ destroyedVersions }) => {
      observed.push([...destroyedVersions]);
      return "proof:analytics";
    };

    await resetCompromisedAppIdentity(
      identityStore,
      input.appId,
      "reset-versions",
      purgers,
      successfulReleasers(),
    );

    expect(observed).toEqual([["local-v1", "v1", "app-v1"]]);
  });

  it("releases remote suppression only after durable activation and retries release", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    await provisionAppIdentity(identityStore, input.appId, ROOT);
    const calls: string[] = [];
    let eventSuppressed = true;
    const releasers = successfulReleasers(calls);
    releasers.event_ingest = async () => {
      calls.push("event_ingest");
      const durable = await identityStore.load(input.appId);
      expect(durable?.lifecycle).toMatchObject({
        state: "activation_pending",
        trafficBlocked: true,
        resetId: "reset-release",
        releaseProofs: { evaluation: "release:evaluation", event_ingest: null },
      });
      expect(durable?.currentVersion).toBe("app-v2");
      if (calls.filter((call) => call === "event_ingest").length === 1) {
        throw new Error("second service unavailable");
      }
      eventSuppressed = false;
      return "release:event_ingest";
    };

    await expect(
      resetCompromisedAppIdentity(
        identityStore,
        input.appId,
        "reset-release",
        successfulPurgers(),
        releasers,
      ),
    ).rejects.toThrow(/second service unavailable/);
    expect(eventSuppressed).toBe(true);
    expect(calls).toEqual(["evaluation", "event_ingest"]);

    await expect(
      resetCompromisedAppIdentity(
        identityStore,
        input.appId,
        "reset-release",
        successfulPurgers(),
        releasers,
      ),
    ).resolves.toMatchObject({ currentVersion: "app-v2" });
    expect(calls).toEqual(["evaluation", "event_ingest", "event_ingest"]);
    expect(eventSuppressed).toBe(false);
  });
});

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

function successfulReleasers(calls: string[] = []): AppIdentityResetReleasers {
  const release = (sink: "evaluation" | "event_ingest") => async () => {
    calls.push(sink);
    return `release:${sink}`;
  };
  return { evaluation: release("evaluation"), event_ingest: release("event_ingest") };
}
