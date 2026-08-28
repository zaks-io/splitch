/**
 * Compromised App identity-key reset (ADR-0044). Routine rotation rewraps; this
 * path is the only way to replace the live key after first provision.
 */

import { generateAppIdentityKey, nextAppIdentityVersion } from "./app-identity-key";
import type { AppIdentityRecord } from "./app-identity-record";
import type { AppIdentityStore } from "./app-identity-store";

export const APP_IDENTITY_RESET_CHECKPOINTS = [
  "block_app_traffic",
  "end_runs_and_revoke_credentials",
  "purge_queues_and_outboxes",
  "purge_entity_stores",
  "redact_privacy_request_subject_refs",
  "verify_purge_checkpoints",
  "mint_replacement_epoch",
] as const;

export type AppIdentityResetCheckpoint = (typeof APP_IDENTITY_RESET_CHECKPOINTS)[number];

export type AppIdentityResetAttestation = Record<AppIdentityResetCheckpoint, true>;

export const APP_IDENTITY_RESET_SUBJECT_REF = "redacted:app-identity-reset";

function assertAppIdentityResetCheckpoints(attestation: AppIdentityResetAttestation): void {
  const missing = APP_IDENTITY_RESET_CHECKPOINTS.filter(
    (checkpoint) => attestation[checkpoint] !== true,
  );
  if (missing.length > 0) {
    throw new Error(
      `privacy: App identity reset requires ADR-0044 checkpoints; missing ${missing.join(", ")}`,
    );
  }
}

/**
 * Destroy every retained epoch (rows were purged) and mint the next random
 * active key. Historical compatibility material is not re-pinned: those rows
 * were part of the mandatory App-wide purge.
 */
export async function resetAppIdentityAfterCheckpoints(
  store: AppIdentityStore,
  appId: string,
  attestation: AppIdentityResetAttestation,
): Promise<AppIdentityRecord> {
  assertAppIdentityResetCheckpoints(attestation);
  const current = await store.load(appId);
  if (current === null) {
    throw new Error("privacy: cannot reset an App with no identity record");
  }
  const nextVersion = nextAppIdentityVersion(current.currentVersion);
  const replaced: AppIdentityRecord = {
    currentVersion: nextVersion,
    epochs: [{ version: nextVersion, key: generateAppIdentityKey() }],
  };
  await store.save(appId, replaced, { merge: false });
  return replaced;
}
