/**
 * Transient-resource cleanup for the safe-delivery tracer.
 *
 * The tracer binds to the seeded shared-preview smoke App (it needs the seeded
 * allow/confirm dev+prod Environment pair) and creates only transient Flags, so
 * cleanup is Flag deletion through normal product operations plus an orphan
 * sweep. It never touches the seeded stable Flag, the Environments, or storage.
 */

import assert from "node:assert/strict";

import { deleteFlag, deleteSegment, listFlags } from "./control-plane.mjs";
import { transientFlagKeys } from "./constants.mjs";

export async function cleanupSafeDelivery(deps, resources) {
  const failures = [];
  for (const [label, flagId] of Object.entries(resources.flagIds)) {
    if (!flagId) continue;
    try {
      await deleteFlag(deps, resources.appId, flagId, label);
      resources.flagIds[label] = null;
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (resources.segmentId) {
    const removal = await deleteSegment(deps, resources.appId, resources.segmentId);
    if (!removal.ok) {
      failures.push(`segment: HTTP ${removal.status} ${JSON.stringify(removal.body)}`);
    } else {
      resources.segmentId = null;
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `safe-delivery cleanup failed to delete transient Flags: ${failures.join("; ")}`,
    );
  }
}

/**
 * Fail loud if any transient Flag from this run survived cleanup, and prove the
 * seeded stable Flag is still present (cleanup must not over-delete).
 */
export async function assertNoOrphans(deps, appId, keys, stableFlagKey) {
  const flags = await listFlags(deps, appId);
  const present = new Set((flags.items ?? flags.flags ?? []).map((flag) => flag.key));
  const orphans = transientFlagKeys(keys).filter((key) => present.has(key));
  assert.deepEqual(orphans, [], `safe-delivery cleanup left orphaned Flags: ${orphans.join(", ")}`);
  if (stableFlagKey) {
    assert.ok(
      present.has(stableFlagKey),
      `safe-delivery cleanup removed the seeded stable Flag ${stableFlagKey}`,
    );
  }
  return { orphanedFlags: orphans.length > 0, stableFlagPreserved: true };
}

/**
 * Sweep any safe-delivery Flag left behind by an earlier crashed run.
 *
 * SINGLE-RUN ASSUMPTION, read this before scheduling the tracer concurrently:
 * the sweep matches every `safe-delivery-` Flag in the App, not just this run's
 * slug, so two tracers running at once against the same App WILL delete each
 * other's live transient Flags and fail in confusing ways. The tracer is
 * deliberately serialized (one workflow step, runs looped in-process) and must
 * stay that way unless this sweep is narrowed to the run slug.
 */
export async function sweepOrphanedSafeDeliveryFlags(deps, appId) {
  const flags = await listFlags(deps, appId);
  const stragglers = (flags.items ?? flags.flags ?? []).filter((flag) =>
    flag.key.startsWith("safe-delivery-"),
  );
  for (const flag of stragglers) {
    await deleteFlag(deps, appId, flag.id, "sweep");
  }
  return stragglers.map((flag) => flag.key);
}
