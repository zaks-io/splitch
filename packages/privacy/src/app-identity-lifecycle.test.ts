import { describe, expect, it } from "vitest";
import type { AppIdentityResetPurgers } from "./app-identity-reset";
import { resetCompromisedAppIdentity } from "./app-identity-reset";
import { makeMemoryAppIdentityStore, provisionAppIdentity } from "./app-identity-store";
import { makeIdentitySaltStore } from "./derived-salt-store";
import { computeTargetingKeyHash } from "./hash";

const ROOT = "test-root-secret-do-not-use";
const INPUT = { appId: "app_1", idType: "user", targetingKey: "user-123" } as const;

describe("App identity compromised lifecycle", () => {
  it("blocks current-epoch Evaluation and Event Ingest until activation", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    const store = makeIdentitySaltStore({ rootSecret: ROOT, identityStore });
    await provisionAppIdentity(identityStore, INPUT.appId, ROOT);
    let markAssignmentStarted: (() => void) | undefined;
    const assignmentStarted = new Promise<void>((resolve) => {
      markAssignmentStarted = resolve;
    });
    const purgers = successfulPurgers();
    purgers.assignments = async () => {
      markAssignmentStarted?.();
      await new Promise(() => undefined);
      return "unreachable";
    };
    void resetCompromisedAppIdentity(identityStore, INPUT.appId, "reset-1", purgers);
    await assignmentStarted;

    await expect(store.currentKeyVersion(INPUT.appId)).rejects.toThrow(/traffic is blocked/);
    await expect(computeTargetingKeyHash(store, INPUT)).rejects.toThrow(/traffic is blocked/);
    await expect(computeTargetingKeyHash(store, { ...INPUT, keyVersion: "v1" })).rejects.toThrow(
      /traffic is blocked/,
    );
    await expect(store.retainedKeyVersions(INPUT.appId)).rejects.toThrow(/traffic is blocked/);
  });

  it("refuses an empty real-store purge proof", async () => {
    const identityStore = makeMemoryAppIdentityStore();
    await provisionAppIdentity(identityStore, INPUT.appId, ROOT);
    const purgers = successfulPurgers();
    purgers.assignments = async () => "";
    await expect(
      resetCompromisedAppIdentity(identityStore, INPUT.appId, "reset-1", purgers),
    ).rejects.toThrow(/assignments reset proof is empty/);
  });
});

function successfulPurgers(): AppIdentityResetPurgers {
  return {
    runs_and_credentials: async () => "runs-proof",
    delivery: async () => "delivery-proof",
    assignments: async () => "assignments-proof",
    analytics: async () => "analytics-proof",
    retry_claims: async () => "retry-proof",
    entity_deletions: async () => "deletion-proof",
    privacy_subject_refs: async () => "subject-proof",
  };
}
