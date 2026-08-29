/** One resumable, serialized ADR-0044 compromised-key reset workflow. */

import { generateAppIdentityKey, nextAppIdentityVersion } from "./app-identity-key";
import {
  APP_IDENTITY_RESET_RELEASES,
  APP_IDENTITY_RESET_STORES,
  type AppIdentityResetRelease,
  type AppIdentityResetStore,
  activationPendingAppIdentityLifecycle,
  activeAppIdentityLifecycle,
  assertAppIdentityResetProved,
  blockedAppIdentityLifecycle,
  withAppIdentityResetProof,
  withAppIdentityResetReleaseProof,
} from "./app-identity-lifecycle";
import type { AppIdentityRecord } from "./app-identity-record";
import { type AppIdentityStore, requireAppIdentityRecord } from "./app-identity-store";

export const APP_IDENTITY_RESET_SUBJECT_REF = "redacted:app-identity-reset";

export type AppIdentityResetPurger = (input: {
  appId: string;
  currentVersion: string;
  destroyedVersions: readonly string[];
}) => Promise<string>;

export type AppIdentityResetPurgers = Record<AppIdentityResetStore, AppIdentityResetPurger>;
export type AppIdentityResetReleasers = Record<
  AppIdentityResetRelease,
  (record: AppIdentityRecord) => Promise<string>
>;

export async function resetCompromisedAppIdentity(
  store: AppIdentityStore,
  appId: string,
  resetId: string,
  purgers: AppIdentityResetPurgers,
  releasers: AppIdentityResetReleasers,
): Promise<AppIdentityRecord> {
  if (store.resetSerialization === "process-local") {
    throw new Error("privacy: compromised App identity reset requires a durable serialized owner");
  }
  return store.runExclusive(appId, () => runReset(store, appId, resetId, purgers, releasers));
}

async function runReset(
  store: AppIdentityStore,
  appId: string,
  resetId: string,
  purgers: AppIdentityResetPurgers,
  releasers: AppIdentityResetReleasers,
): Promise<AppIdentityRecord> {
  let current = await requireAppIdentityRecord(store, appId);
  if (current.lifecycle.state === "active" && current.lifecycle.resetId === resetId) {
    return current;
  }
  if (current.lifecycle.state === "active") {
    current = { ...current, lifecycle: blockedAppIdentityLifecycle(resetId) };
    await store.save(appId, current);
  } else if (current.lifecycle.resetId !== resetId) {
    throw new Error("privacy: a different App identity reset is already running");
  }
  if (current.lifecycle.state !== "activation_pending") {
    current = await purgePendingStores(store, appId, current, purgers);
    assertAppIdentityResetProved(current.lifecycle);
    const nextVersion = nextAppIdentityVersion(current.currentVersion);
    current = {
      currentVersion: nextVersion,
      lifecycle: activationPendingAppIdentityLifecycle(current.lifecycle),
      epochs: [{ version: nextVersion, role: "active", key: generateAppIdentityKey() }],
    };
    await store.save(appId, current);
  }
  current = await releasePendingSinks(store, appId, current, releasers);
  current = { ...current, lifecycle: activeAppIdentityLifecycle(current.lifecycle) };
  await store.save(appId, current);
  return current;
}

async function releasePendingSinks(
  store: AppIdentityStore,
  appId: string,
  initial: AppIdentityRecord,
  releasers: AppIdentityResetReleasers,
): Promise<AppIdentityRecord> {
  let current = initial;
  for (const release of APP_IDENTITY_RESET_RELEASES) {
    if (current.lifecycle.releaseProofs[release] !== null) continue;
    const proof = await releasers[release](current);
    current = {
      ...current,
      lifecycle: withAppIdentityResetReleaseProof(current.lifecycle, release, proof),
    };
    await store.save(appId, current);
  }
  return current;
}

async function purgePendingStores(
  store: AppIdentityStore,
  appId: string,
  initial: AppIdentityRecord,
  purgers: AppIdentityResetPurgers,
): Promise<AppIdentityRecord> {
  let current = initial;
  const destroyedVersions = [...new Set(current.epochs.map((epoch) => epoch.version))];
  for (const surface of APP_IDENTITY_RESET_STORES) {
    if (current.lifecycle.proofs[surface] !== null) continue;
    const proof = await purgers[surface]({
      appId,
      currentVersion: current.currentVersion,
      destroyedVersions,
    });
    current = {
      ...current,
      lifecycle: withAppIdentityResetProof(current.lifecycle, surface, proof),
    };
    await store.save(appId, current);
  }
  return current;
}
