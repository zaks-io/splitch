/** One resumable, serialized ADR-0044 compromised-key reset workflow. */

import { generateAppIdentityKey, nextAppIdentityVersion } from "./app-identity-key";
import {
  ACTIVE_APP_IDENTITY_LIFECYCLE,
  APP_IDENTITY_RESET_STORES,
  type AppIdentityResetStore,
  assertAppIdentityResetProved,
  blockedAppIdentityLifecycle,
  withAppIdentityResetProof,
} from "./app-identity-lifecycle";
import type { AppIdentityRecord } from "./app-identity-record";
import { type AppIdentityStore, requireAppIdentityRecord } from "./app-identity-store";

export const APP_IDENTITY_RESET_SUBJECT_REF = "redacted:app-identity-reset";

export type AppIdentityResetPurger = (input: {
  appId: string;
  currentVersion: string;
}) => Promise<string>;

export type AppIdentityResetPurgers = Record<AppIdentityResetStore, AppIdentityResetPurger>;

export async function resetCompromisedAppIdentity(
  store: AppIdentityStore,
  appId: string,
  resetId: string,
  purgers: AppIdentityResetPurgers,
  beforeActivate?: () => Promise<void>,
): Promise<AppIdentityRecord> {
  if (store.resetSerialization === "process-local") {
    throw new Error("privacy: compromised App identity reset requires a durable serialized owner");
  }
  return store.runExclusive(appId, () => runReset(store, appId, resetId, purgers, beforeActivate));
}

async function runReset(
  store: AppIdentityStore,
  appId: string,
  resetId: string,
  purgers: AppIdentityResetPurgers,
  beforeActivate?: () => Promise<void>,
): Promise<AppIdentityRecord> {
  let current = await requireAppIdentityRecord(store, appId);
  if (current.lifecycle.state === "active" && current.lifecycle.resetId === resetId) return current;
  if (current.lifecycle.state === "active") {
    current = { ...current, lifecycle: blockedAppIdentityLifecycle(resetId) };
    await store.save(appId, current);
  } else if (current.lifecycle.resetId !== resetId) {
    throw new Error("privacy: a different App identity reset is already running");
  }
  current = await purgePendingStores(store, appId, current, purgers);
  assertAppIdentityResetProved(current.lifecycle);
  const nextVersion = nextAppIdentityVersion(current.currentVersion);
  const replaced: AppIdentityRecord = {
    currentVersion: nextVersion,
    lifecycle: { ...ACTIVE_APP_IDENTITY_LIFECYCLE, resetId },
    epochs: [{ version: nextVersion, role: "active", key: generateAppIdentityKey() }],
  };
  await beforeActivate?.();
  await store.save(appId, replaced);
  return replaced;
}

async function purgePendingStores(
  store: AppIdentityStore,
  appId: string,
  initial: AppIdentityRecord,
  purgers: AppIdentityResetPurgers,
): Promise<AppIdentityRecord> {
  let current = initial;
  for (const surface of APP_IDENTITY_RESET_STORES) {
    if (current.lifecycle.proofs[surface] !== null) continue;
    const proof = await purgers[surface]({ appId, currentVersion: current.currentVersion });
    current = {
      ...current,
      lifecycle: withAppIdentityResetProof(current.lifecycle, surface, proof),
    };
    await store.save(appId, current);
  }
  return current;
}
